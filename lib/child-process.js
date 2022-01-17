const path = require('path')
const {
  writeFileSync,
  chmodSync,
  unlinkSync,
  unlink
} = require('./_fs.js')
const os = require('os')
const asar = require('./asar.js')
const { isAsarDisabled, splitPath, createError, AsarError } = require('./util.js')
const childProcess = require('child_process')
const { createHash } = require('crypto')

let registered = false

let oldFork
let oldExecFile
let oldExecFileSync

function copyFileOut (asarPath, filePath) {
  let filesystem
  try {
    filesystem = asar.disk.readFilesystemSync(asarPath)
  } catch (err) {
    throw createError(AsarError.INVALID_ARCHIVE, { asarPath })
  }

  let stats = filesystem.getFileEx(filePath)
  try {
    stats = filesystem.getFileEx(filePath)
  } catch (error) {
    throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
  }

  const fileBuffer = asar.disk.readFileSync(filesystem, filePath, stats)
  let hash
  if (stats.integrity && stats.integrity.hash) {
    hash = stats.integrity.hash
  } else {
    hash = createHash('sha256').update(fileBuffer).digest('hex')
  }

  const tmpFile = `${path.join(os.tmpdir(), hash)}${path.extname(filePath)}`

  writeFileSync(tmpFile, fileBuffer)
  if (stats.executable) {
    chmodSync(tmpFile, '755')
  }
  return tmpFile
}

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

    const tmpFile = copyFileOut(asarPath, filePath)
    try {
      return oldExecFile.apply(this, [tmpFile, args, options, (err, output, stderr) => {
        if (err) return callback && callback(err)
        unlink(tmpFile, () => {
          callback && callback(null, output, stderr)
        })
      }])
    } catch (err) {
      unlinkSync(tmpFile)
      throw err
    }
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

    const tmpFile = copyFileOut(asarPath, filePath)
    let output
    try {
      output = oldExecFileSync.apply(this, [tmpFile, args, options])
    } finally {
      unlinkSync(tmpFile)
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
