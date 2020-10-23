const remixLib = require('@remix-project/remix-lib')
const {txFormat, txExecution, typeConversion, txHelper, txListener: Txlistener, txRunner: TxRunner, executionContext} = remixLib.execution
const EventManager = remixLib.EventManager
const Web3 = require('web3')
const async = require('async')
const { EventEmitter } = require('events')

const { resultToRemixTx } = require('./txResultHelper')

const VMProvider = require('./providers/vm.js')
const InjectedProvider = require('./providers/injected.js')
const NodeProvider = require('./providers/node.js')

class Blockchain {

  // NOTE: the config object will need to be refactored out in remix-lib
  constructor (config) {
    this.event = new EventManager()
    this.executionContext = executionContext

    this.events = new EventEmitter()
    this.config = config

    this.txRunner = new TxRunner({}, {
      config: config,
      detectNetwork: (cb) => {
        this.executionContext.detectNetwork(cb)
      },
      personalMode: () => {
        return this.getProvider() === 'web3' ? this.config.get('settings/personal-mode') : false
      }
    }, this.executionContext)
    this.executionContext.event.register('contextChanged', this.resetEnvironment.bind(this))

    this.networkcallid = 0
    this.setupEvents()
    this.setupProviders()
  }

  setupEvents () {
    this.executionContext.event.register('contextChanged', (context, silent) => {
      this.event.trigger('contextChanged', [context, silent])
    })

    this.executionContext.event.register('addProvider', (network) => {
      this.event.trigger('addProvider', [network])
    })

    this.executionContext.event.register('removeProvider', (name) => {
      this.event.trigger('removeProvider', [name])
    })
  }

  setupProviders () {
    this.providers = {}
    this.providers.vm = new VMProvider(this.executionContext)
    this.providers.injected = new InjectedProvider(this.executionContext)
    this.providers.web3 = new NodeProvider(this.executionContext, this.config)
  }

  getCurrentProvider () {
    const provider = this.getProvider()
    if (this.providers[provider]) return this.providers[provider]
    return this.providers.web3 // default to the common type of provider
  }

  /** Return the list of accounts */
  // note: the dual promise/callback is kept for now as it was before
  getAccounts (cb) {
    return new Promise((resolve, reject) => {
      this.getCurrentProvider().getAccounts((error, accounts) => {
        if (cb) {
          return cb(error, accounts)
        }
        if (error) {
          reject(error)
        }
        resolve(accounts)
      })
    })
  }

  deployContractAndLibraries (selectedContract, args, contractMetadata, compilerContracts, callbacks, confirmationCb) {
    const { continueCb, promptCb, statusCb, finalCb } = callbacks
    const constructor = selectedContract.getConstructorInterface()
    txFormat.buildData(selectedContract.name, selectedContract.object, compilerContracts, true, constructor, args, (error, data) => {
      if (error) return statusCb(`creation of ${selectedContract.name} errored: ` + error)

      statusCb(`creation of ${selectedContract.name} pending...`)
      this.createContract(selectedContract, data, continueCb, promptCb, confirmationCb, finalCb)
    }, statusCb, (data, runTxCallback) => {
      // called for libraries deployment
      this.runTx(data, confirmationCb, continueCb, promptCb, runTxCallback)
    })
  }

  deployContractWithLibrary (selectedContract, args, contractMetadata, compilerContracts, callbacks, confirmationCb) {
    const { continueCb, promptCb, statusCb, finalCb } = callbacks
    const constructor = selectedContract.getConstructorInterface()
    txFormat.encodeConstructorCallAndLinkLibraries(selectedContract.object, args, constructor, contractMetadata.linkReferences, selectedContract.bytecodeLinkReferences, (error, data) => {
      if (error) return statusCb(`creation of ${selectedContract.name} errored: ` + (error.message ? error.message : error))

      statusCb(`creation of ${selectedContract.name} pending...`)
      this.createContract(selectedContract, data, continueCb, promptCb, confirmationCb, finalCb)
    })
  }

  createContract (selectedContract, data, continueCb, promptCb, confirmationCb, finalCb) {
    if (data) {
      data.contractName = selectedContract.name
      data.linkReferences = selectedContract.bytecodeLinkReferences
      data.contractABI = selectedContract.abi
    }

    this.runTx({ data: data, useCall: false }, confirmationCb, continueCb, promptCb,
      (error, txResult, address) => {
        if (error) {
          return finalCb(`creation of ${selectedContract.name} errored: ${(error.message ? error.message : error)}`)
        }
        if (txResult.result.status && txResult.result.status === '0x0') {
          return finalCb(`creation of ${selectedContract.name} errored: transaction execution failed`)
        }
        finalCb(null, selectedContract, address)
      }
    )
  }

  determineGasPrice (cb) {
    this.getCurrentProvider().getGasPrice((error, gasPrice) => {
      const warnMessage = ' Please fix this issue before sending any transaction. '
      if (error) {
        return cb('Unable to retrieve the current network gas price.' + warnMessage + error)
      }
      try {
        const gasPriceValue = this.fromWei(gasPrice, false, 'gwei')
        cb(null, gasPriceValue)
      } catch (e) {
        cb(warnMessage + e.message, null, false)
      }
    })
  }

  getInputs (funABI) {
    if (!funABI.inputs) {
      return ''
    }
    return txHelper.inputParametersDeclarationToString(funABI.inputs)
  }

  fromWei (value, doTypeConversion, unit) {
    if (doTypeConversion) {
      return Web3.utils.fromWei(typeConversion.toInt(value), unit || 'ether')
    }
    return Web3.utils.fromWei(value.toString(10), unit || 'ether')
  }

  toWei (value, unit) {
    return Web3.utils.toWei(value, unit || 'gwei')
  }

  calculateFee (gas, gasPrice, unit) {
    return Web3.utils.toBN(gas).mul(Web3.utils.toBN(Web3.utils.toWei(gasPrice.toString(10), unit || 'gwei')))
  }

  determineGasFees (tx) {
    const determineGasFeesCb = (gasPrice, cb) => {
      let txFeeText, priceStatus
      // TODO: this try catch feels like an anti pattern, can/should be
      // removed, but for now keeping the original logic
      try {
        const fee = this.calculateFee(tx.gas, gasPrice)
        txFeeText = ' ' + this.fromWei(fee, false, 'ether') + ' Ether'
        priceStatus = true
      } catch (e) {
        txFeeText = ' Please fix this issue before sending any transaction. ' + e.message
        priceStatus = false
      }
      cb(txFeeText, priceStatus)
    }

    return determineGasFeesCb
  }

  changeExecutionContext (context, confirmCb, infoCb, cb) {
    return this.executionContext.executionContextChange(context, null, confirmCb, infoCb, cb)
  }

  setProviderFromEndpoint (target, context, cb) {
    return this.executionContext.setProviderFromEndpoint(target, context, cb)
  }

  updateNetwork (cb) {
    this.executionContext.detectNetwork((err, { id, name } = {}) => {
      if (err) {
        return cb(err)
      }
      cb(null, {id, name})
    })
  }

  detectNetwork (cb) {
    return this.executionContext.detectNetwork(cb)
  }

  getProvider () {
    return this.executionContext.getProvider()
  }

  isWeb3Provider () {
    const isVM = this.getProvider() === 'vm'
    const isInjected = this.getProvider() === 'injected'
    return (!isVM && !isInjected)
  }

  isInjectedWeb3 () {
    return this.getProvider() === 'injected'
  }

  signMessage (message, account, passphrase, cb) {
    this.getCurrentProvider().signMessage(message, account, passphrase, cb)
  }

  web3 () {
    return this.executionContext.web3()
  }

  getTxListener (opts) {
    opts.event = {
      // udapp: this.udapp.event
      udapp: this.event
    }
    const txlistener = new Txlistener(opts, this.executionContext)
    return txlistener
  }

  async callMethod (address, abi, methodName, outputCb) {
    const self = this

    let gasLimit = 3000000
    if (self.transactionContextAPI.getGasLimit) {
      gasLimit = self.transactionContextAPI.getGasLimit()
    }
    let value = 0

    // if (args.value) {
    //   value = args.value
    // } else if (args.useCall || !self.transactionContextAPI.getValue) {
    //   value = 0
    // } else {
    //   value = self.transactionContextAPI.getValue()
    // }

    let from

    // if (args.from) {
      // from = args.from
    // } else if (self.transactionContextAPI.getAddress) {
    if (self.transactionContextAPI.getAddress) {
      from = self.transactionContextAPI.getAddress()
    } else {
      try {
        let accounts = await self.getAccounts()

        let address = accounts[0]

        if (!address) throw new Error('No accounts available')
        if (self.executionContext.isVM() && !self.providers.vm.RemixSimulatorProvider.Accounts.accounts[address]) {
          throw new Error('Invalid account selected')
        }
        from = address
      } catch (err) {
        from = 0
      }
    }

    // const tx = { to: address, data: args.data.dataHex, useCall: true, from, value, gasLimit, timestamp: args.data.timestamp }
    // const tx = { to: address, data: args.data.dataHex, useCall: true, from, value, gasLimit, timestamp: Date.now() }
    const tx = { to: address, data: "0x123", useCall: true, from, value, gasLimit, timestamp: Date.now() }
    // const payLoad = { funAbi: args.data.funAbi, funArgs: args.data.funArgs, contractBytecode: args.data.contractBytecode, contractName: args.data.contractName, contractABI: args.data.contractABI, linkReferences: args.data.linkReferences }
    const payLoad = {}
    let timestamp = tx.timestamp || Date.now()

    // self.event.trigger('initiatingTransaction', [timestamp, tx, payLoad])

    // return this.getCurrentProvider().callMethod(address, abi, methodName, (returnValue) => {
    const returnValue = await this.getCurrentProvider().callMethod(address, abi, methodName)

    console.dir("====================")
    console.dir([null, tx.from, tx.to, tx.data, tx.useCall, returnValue, timestamp, payLoad, address])
    console.dir("====================")

    // self.event.trigger('callExecuted', [null, tx.from, tx.to, tx.data, tx.useCall, returnValue, timestamp, payLoad, rawAddress])
    self.event.trigger('callExecuted', [null, tx.from, tx.to, tx.data, tx.useCall, returnValue, timestamp, payLoad, address])
    // this.event.trigger('callExecuted', [])
    outputCb(returnValue)
    // })
  }

  runOrCallContractMethod (contractName, contractAbi, funABI, value, address, callType, lookupOnly, logMsg, logCallback, outputCb, confirmationCb, continueCb, promptCb) {
    console.dir("======")
    console.dir("runOrCallContractMethod")
    // contractsDetails is used to resolve libraries
    txFormat.buildData(contractName, contractAbi, {}, false, funABI, callType, (error, data) => {
      if (error) {
        return logCallback(`${logMsg} errored: ${error} `)
      }
      if (!lookupOnly) {
        logCallback(`${logMsg} pending ... `)
      } else {
        logCallback(`${logMsg}`)
      }
      if (funABI.type === 'fallback') data.dataHex = value

      const useCall = funABI.stateMutability === 'view' || funABI.stateMutability === 'pure'
      this.runTx({to: address, data, useCall}, confirmationCb, continueCb, promptCb, (error, txResult, _address, returnValue) => {
        if (error) {
          return logCallback(`${logMsg} errored: ${error} `)
        }
        if (lookupOnly) {
          outputCb(returnValue)
        }
      })
    },
    (msg) => {
      logCallback(msg)
    },
    (data, runTxCallback) => {
      // called for libraries deployment
      this.runTx(data, confirmationCb, runTxCallback, promptCb, () => {})
    })
  }

  context () {
    return (this.executionContext.isVM() ? 'memory' : 'blockchain')
  }

  // NOTE: the config is only needed because exectuionContext.init does
  // if config.get('settings/always-use-vm'), we can simplify this later
  resetAndInit (config, transactionContextAPI) {
    this.transactionContextAPI = transactionContextAPI
    this.executionContext.init(config)
    this.executionContext.stopListenOnLastBlock()
    this.executionContext.listenOnLastBlock()
    this.resetEnvironment()
  }

  addProvider (provider) {
    this.executionContext.addProvider(provider)
  }

  removeProvider (name) {
    this.executionContext.removeProvider(name)
  }

  // TODO : event should be triggered by Udapp instead of TxListener
  /** Listen on New Transaction. (Cannot be done inside constructor because txlistener doesn't exist yet) */
  startListening (txlistener) {
    txlistener.event.register('newTransaction', (tx) => {
      this.events.emit('newTransaction', tx)
    })
  }

  resetEnvironment () {
    this.getCurrentProvider().resetEnvironment()
    // TODO: most params here can be refactored away in txRunner
    // this.txRunner = new TxRunner(this.providers.vm.accounts, {
    this.txRunner = new TxRunner(this.providers.vm.RemixSimulatorProvider.Accounts.accounts, {
      // TODO: only used to check value of doNotShowTransactionConfirmationAgain property
      config: this.config,
      // TODO: to refactor, TxRunner already has access to executionContext
      detectNetwork: (cb) => {
        this.executionContext.detectNetwork(cb)
      },
      personalMode: () => {
        return this.getProvider() === 'web3' ? this.config.get('settings/personal-mode') : false
      }
    }, this.executionContext)
    this.txRunner.event.register('transactionBroadcasted', (txhash) => {
      this.executionContext.detectNetwork((error, network) => {
        if (error || !network) return
        this.event.trigger('transactionBroadcasted', [txhash, network.name])
      })
    })
  }

  /**
   * Create a VM Account
   * @param {{privateKey: string, balance: string}} newAccount The new account to create
   */
  createVMAccount (newAccount) {
    if (this.getProvider() !== 'vm') {
      throw new Error('plugin API does not allow creating a new account through web3 connection. Only vm mode is allowed')
    }
    return this.providers.vm.createVMAccount(newAccount)
  }

  newAccount (_password, passwordPromptCb, cb) {
    return this.getCurrentProvider().newAccount(passwordPromptCb, cb)
  }

  /** Get the balance of an address, and convert wei to ether */
  getBalanceInEther (address, cb) {
    this.getCurrentProvider().getBalanceInEther(address, cb)
  }

  pendingTransactionsCount () {
    return Object.keys(this.txRunner.pendingTxs).length
  }

  /**
   * This function send a tx only to javascript VM or testnet, will return an error for the mainnet
   * SHOULD BE TAKEN CAREFULLY!
   *
   * @param {Object} tx    - transaction.
   */
  sendTransaction (tx) {
    return new Promise((resolve, reject) => {
      this.executionContext.detectNetwork((error, network) => {
        if (error) return reject(error)
        if (network.name === 'Main' && network.id === '1') {
          return reject(new Error('It is not allowed to make this action against mainnet'))
        }

        this.txRunner.rawRun(
          tx,
          (network, tx, gasEstimation, continueTxExecution, cancelCb) => { continueTxExecution() },
          (error, continueTxExecution, cancelCb) => { if (error) { reject(error) } else { continueTxExecution() } },
          (okCb, cancelCb) => { okCb() },
          (error, result) => {
            if (error) return reject(error)
            try {
              resolve(resultToRemixTx(result))
            } catch (e) {
              reject(e)
            }
          }
        )
      })
    })
  }

  // contract deployment
  // contract deployment with libraries
  // transaction
  // call
  async runTx(args, confirmationCb, continueCb, promptCb, cb) {
    console.dir("====== runTx")
    console.dir(args)
    const self = this

    let gasLimit = 3000000
    if (self.transactionContextAPI.getGasLimit) {
      gasLimit = self.transactionContextAPI.getGasLimit()
    }
    let value = 0

    if (args.value) {
      value = args.value
    } else if (args.useCall || !self.transactionContextAPI.getValue) {
      value = 0
    } else {
      value = self.transactionContextAPI.getValue()
    }

    let from

    if (args.from) {
      from = args.from
    } else if (self.transactionContextAPI.getAddress) {
      from = self.transactionContextAPI.getAddress()
    } else {
      try {
        let accounts = await self.getAccounts()

        let address = accounts[0]

        if (!address) throw new Error('No accounts available')
        if (self.executionContext.isVM() && !self.providers.vm.RemixSimulatorProvider.Accounts.accounts[address]) {
          throw new Error('Invalid account selected')
        }
        from = address
      } catch (err) {
        from = 0
      }
    }

    const tx = { to: args.to, data: args.data.dataHex, useCall: args.useCall, from, value, gasLimit, timestamp: args.data.timestamp }
    const payLoad = { funAbi: args.data.funAbi, funArgs: args.data.funArgs, contractBytecode: args.data.contractBytecode, contractName: args.data.contractName, contractABI: args.data.contractABI, linkReferences: args.data.linkReferences }
    let timestamp = tx.timestamp || Date.now()

    self.event.trigger('initiatingTransaction', [timestamp, tx, payLoad])

    // TODO: web3.eth.sendTransaction
    self.txRunner.rawRun(tx, confirmationCb, continueCb, promptCb,
      function (error, result) {
        if (error) return cb(error)

        const rawAddress = self.executionContext.isVM() ? result.result.createdAddress : result.result.contractAddress
        let eventName = (tx.useCall ? 'callExecuted' : 'transactionExecuted')
        self.event.trigger(eventName, [null, tx.from, tx.to, tx.data, tx.useCall, result, timestamp, payLoad, rawAddress])
        console.dir("====================")
        console.dir([null, tx.from, tx.to, tx.data, tx.useCall, result, timestamp, payLoad, rawAddress])
        console.dir("====================")

        let txResult = result

        const isVM = self.executionContext.isVM()
        if (isVM) {
          const vmError = txExecution.checkVMError(txResult)
          if (vmError.error) {
            return cb(vmError.message)
          }
        }

        let address = null
        let returnValue = null
        if (txResult && txResult.result) {
          address = isVM ? txResult.result.createdAddress : txResult.result.contractAddress
          // if it's not the VM, we don't have return value. We only have the transaction, and it does not contain the return value.
          returnValue = (txResult.result.execResult && isVM) ? txResult.result.execResult.returnValue : txResult.result
        }

        cb(null, txResult, address, returnValue)
      }
    )
  }

}

module.exports = Blockchain
