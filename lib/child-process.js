const path = require('path')
const originalFs = require('./original-fs')
const { isAsarDisabled } = require('./util.js')
const childProcess = require('child_process')

let registered = false

let oldFork
let oldExecFile
let oldExecFileSync

function overwriteChildProcess () {
  if (registered) return
  oldFork = childProcess.fork
  childProcess.fork = function (modulePath, args, options) {
    if (isAsarDisabled()) {
      return oldFork.apply(this, arguments)
    }
    return oldFork.call(this, require('path').join(__dirname, 'fork.js'), [
      registered ? '1' : '0',
      require('./lookup.js').checkLookupState() ? '1' : '0',
      path.resolve(modulePath),
      ...(args || [])
    ], options)
  }

  oldExecFile = childProcess.execFile
  function execFile (file, args, options, callback) {
    if (isAsarDisabled()) {
      return oldExecFile.apply(this, arguments)
    }
    const { isAsar, asarPath, pathInAsar } = require('./util.js').splitPath(path.resolve(file))
    if (!isAsar || pathInAsar === '') return oldExecFile.apply(this, arguments)

    if (typeof args === 'function') {
      callback = args
      args = []
      options = undefined
    } else if (typeof options === 'function') {
      callback = options
      options = undefined
    }

    const fileBuffer = require('./asar.js').extractFile(asarPath, pathInAsar)
    const md5 = require('crypto').createHash('md5').update(fileBuffer).digest('hex')
    const os = require('os')
    const tmpFile = `${path.join(os.tmpdir(), md5)}${process.platform === 'win32' ? '.exe' : ''}`

    originalFs.writeFileSync(tmpFile, fileBuffer)
    originalFs.chmodSync(tmpFile, '755')
    const cp = oldExecFile.apply(this, [tmpFile, args, options, (err, output, stderr) => {
      if (err) return callback && callback(err)
      originalFs.unlink(tmpFile, () => {
        callback && callback(null, output, stderr)
      })
    }])

    return cp
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
    const { isAsar, asarPath, pathInAsar } = require('./util.js').splitPath(path.resolve(file))
    if (!isAsar || pathInAsar === '') return oldExecFileSync.apply(this, arguments)

    const fileBuffer = require('./asar.js').extractFile(asarPath, pathInAsar)
    const md5 = require('crypto').createHash('md5').update(fileBuffer).digest('hex')
    const os = require('os')
    const tmpFile = `${path.join(os.tmpdir(), md5)}${process.platform === 'win32' ? '.exe' : ''}`
    originalFs.writeFileSync(tmpFile, fileBuffer)
    originalFs.chmodSync(tmpFile, '755')
    let output
    try {
      output = oldExecFileSync.apply(this, [tmpFile, args, options])
    } finally {
      originalFs.unlinkSync(tmpFile)
    }
    return output
  }

  registered = true
}

function cancel () {
  if (!registered) return

  childProcess.fork = oldFork
  oldFork = undefined
  childProcess.execFile = oldExecFile
  oldExecFile = undefined
  childProcess.execFileSync = oldExecFileSync
  oldExecFileSync = undefined

  registered = false
}

exports.overwriteChildProcess = overwriteChildProcess
exports.cancel = cancel
