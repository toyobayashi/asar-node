const path = require('path')
const util = require('util')
const { getOrCreateArchive } = require('./archive.js')
const { isAsarDisabled, splitPath, createError, AsarError, invokeWithNoAsar } = require('./util/index.js')
const childProcess = require('child_process')

let registered = false

// let oldFork
let oldExecFile
let oldExecFileSync
let oldExec
let oldExecSync

function overwriteChildProcess () {
  if (registered) return
  /* oldFork = childProcess.fork
  childProcess.fork = function (modulePath, args, options) {
    if (isAsarDisabled()) {
      return oldFork.apply(this, arguments)
    }
    if (Array.isArray(args)) {
      options = options || {}
    } else {
      if (typeof args === 'object' && args !== null) {
        options = args
        args = []
      } else {
        options = options || {}
        args = args || []
      }
    }
    options.env = options.env || {}
    options.env.__ASAR_NODE_CHILD_PROCESS__ = '1'
    const forkEntry = typeof ASAR_NODE_FORK_ENTRY !== 'undefined'
      ? ASAR_NODE_FORK_ENTRY
      : require('path').join(__dirname, 'fork.js')
    return oldFork.call(this, forkEntry, [
      registered ? '1' : '0',
      require('./lookup.js').checkLookupState() ? '1' : '0',
      path.resolve(modulePath),
      ...(args || [])
    ], options)
  } */

  oldExec = childProcess.exec
  childProcess.exec = invokeWithNoAsar(oldExec)
  childProcess.exec[util.promisify.custom] = invokeWithNoAsar(oldExec[util.promisify.custom])
  oldExecSync = childProcess.execSync
  childProcess.execSync = invokeWithNoAsar(oldExecSync)

  oldExecFile = childProcess.execFile
  function execFile (file, args, options, callback) {
    if (isAsarDisabled()) {
      return oldExecFile.apply(this, arguments)
    }
    const { isAsar, asarPath, filePath } = splitPath(path.resolve(file))
    if (!isAsar || filePath === '') return oldExecFile.apply(this, arguments)

    if (typeof args === 'function') {
      callback = args
      args = []
      options = undefined
    } else if (typeof options === 'function') {
      callback = options
      options = undefined
    }

    const archive = getOrCreateArchive(asarPath)
    if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })
    const newPath = archive.copyFileOut(filePath)
    if (!newPath) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
    return oldExecFile.apply(this, [newPath, args, options, (err, output, stderr) => {
      if (err) return callback && callback(err)
      callback && callback(null, output, stderr)
    }])
  }
  const promisifySymbol = require('util').promisify.custom
  Object.defineProperty(execFile, promisifySymbol, {
    configurable: true,
    value: function (file, args, options) {
      return new Promise((resolve, reject) => {
        execFile(file, args, options, (err, stdout, stderr) => {
          if (err) return reject(err)
          resolve({ stdout, stderr })
        })
      })
    }
  })
  childProcess.execFile = execFile

  oldExecFileSync = childProcess.execFileSync
  childProcess.execFileSync = function (file, args, options) {
    if (isAsarDisabled()) {
      return oldExecFileSync.apply(this, arguments)
    }
    const { isAsar, asarPath, filePath } = splitPath(path.resolve(file))
    if (!isAsar || filePath === '') return oldExecFileSync.apply(this, arguments)

    const archive = getOrCreateArchive(asarPath)
    if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })
    const newPath = archive.copyFileOut(filePath)
    if (!newPath) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
    const output = oldExecFileSync.apply(this, [newPath, args, options])
    return output
  }

  registered = true
}

function cancel () {
  if (!registered) return

  // childProcess.fork = oldFork
  // oldFork = undefined
  childProcess.exec = oldExec
  oldExec = undefined
  childProcess.execSync = oldExecSync
  oldExecSync = undefined
  childProcess.execFile = oldExecFile
  oldExecFile = undefined
  childProcess.execFileSync = oldExecFileSync
  oldExecFileSync = undefined

  registered = false
}

exports.overwriteChildProcess = overwriteChildProcess
exports.cancel = cancel
