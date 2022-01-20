const {
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmdirSync
} = require('../fs/index.js')
const path = require('path')
const { tmpdir } = require('os')

const {
  envNoAsar,
  isAsarDisabled,
  getModuleConstructor
} = require('./env.js')

/**
 * @param {string} filepath
 * @returns {string}
 */
function tryRedirectUnpacked (filepath) {
  const dir = path.dirname(filepath)
  const dirInfo = splitPath(dir)
  if (dirInfo.isAsar) {
    return path.join(dirInfo.asarPath + '.unpacked', dirInfo.filePath, path.basename(filepath))
  } else {
    return filepath
  }
}

/**
 * @param {string} archivePath
 * @returns {{ isAsar: false } | { isAsar: true; asarPath: string; filePath: string }}
 */
function splitPath (archivePath) {
  const r = {
    isAsar: false
  }
  if (isAsarDisabled()) return r
  if (typeof archivePath !== 'string') return r
  if (archivePath.endsWith('.asar')) {
    if (existsSync(archivePath) && statSync(archivePath).isFile()) {
      r.isAsar = true
      r.asarPath = tryRedirectUnpacked(archivePath)
      r.filePath = ''
    }
    return r
  }
  const indexWindows = archivePath.lastIndexOf('.asar\\')
  const indexPosix = archivePath.lastIndexOf('.asar/')
  if (indexWindows === -1 && indexPosix === -1) return r
  const index = indexPosix === -1 ? indexWindows : indexPosix

  const archive = archivePath.substring(0, index + 5)

  if (existsSync(archive) && statSync(archive).isFile()) {
    r.isAsar = true
    r.asarPath = tryRedirectUnpacked(archive)
    r.filePath = archivePath.substring(index + 6)
  }

  return r
}

const AsarError = {
  NOT_FOUND: 'NOT_FOUND',
  NOT_DIR: 'NOT_DIR',
  NO_ACCESS: 'NO_ACCESS',
  INVALID_ARCHIVE: 'INVALID_ARCHIVE'
}

const createError = (errorType, { asarPath, filePath } = {}) => {
  let error
  switch (errorType) {
    case AsarError.NOT_FOUND:
      error = new Error(`ENOENT, ${filePath} not found in ${asarPath}`)
      error.code = 'ENOENT'
      error.errno = -2
      break
    case AsarError.NOT_DIR:
      error = new Error('ENOTDIR, not a directory')
      error.code = 'ENOTDIR'
      error.errno = -20
      break
    case AsarError.NO_ACCESS:
      error = new Error(`EACCES: permission denied, access '${filePath}' in ${asarPath}`)
      error.code = 'EACCES'
      error.errno = -13
      break
    case AsarError.INVALID_ARCHIVE:
      error = new Error(`Invalid package ${asarPath}`)
      break
    default:
      throw new Error(`Invalid error type "${errorType}" passed to createError.`)
  }
  return error
}

function assertCallback (callback) {
  if (typeof callback !== 'function') {
    throw new TypeError(`Callback must be a function. Received ${typeof callback}`)
  }
}

const TEMP_DIR = path.join(tmpdir(), 'asar-node-tmp')

function cleanTempDir () {
  if (existsSync(TEMP_DIR)) {
    try {
      readdirSync(TEMP_DIR).forEach(item => {
        unlinkSync(path.join(TEMP_DIR, item))
      })
      rmdirSync(TEMP_DIR)
    } catch (_) {}
  }
}

function initTempDir () {
  if (process.env.__ASAR_NODE_CHILD_PROCESS__ ||
      !require('worker_threads').isMainThread ||
      existsSync(path.join(TEMP_DIR, '.lock'))) {
    return
  }
  cleanTempDir()
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR)
    closeSync(openSync(path.join(TEMP_DIR, '.lock'), 'w'))
  }
  if (process.listeners('exit').indexOf(cleanTempDir) === -1) {
    process.on('exit', cleanTempDir)
  }
}

const BUFFER_SIZE = 64 * 1024
function readFileChunk (fd, start, end, callback) {
  const range = [start, end]
  const buffer = Buffer.alloc(BUFFER_SIZE)
  let bytesRead = 0
  let pos = range[0]

  while (pos !== range[1]) {
    const left = range[1] - pos
    if (left < BUFFER_SIZE) {
      bytesRead = readSync(fd, buffer, 0, left, pos)
    } else {
      bytesRead = readSync(fd, buffer, 0, BUFFER_SIZE, pos)
    }
    pos += bytesRead
    callback(buffer.slice(0, bytesRead), pos)
  }
}

function invokeWithNoAsar (func) {
  return function () {
    const processNoAsarOriginalValue = process.noAsar
    process.noAsar = true
    try {
      return func.apply(this, arguments)
    } finally {
      process.noAsar = processNoAsarOriginalValue
    }
  }
}

exports.envNoAsar = envNoAsar
exports.isAsarDisabled = isAsarDisabled
exports.tryRedirectUnpacked = tryRedirectUnpacked
exports.splitPath = splitPath
exports.AsarError = AsarError
exports.createError = createError
exports.assertCallback = assertCallback
exports.getModuleConstructor = getModuleConstructor
exports.readFileChunk = readFileChunk
exports.TEMP_DIR = TEMP_DIR
exports.initTempDir = initTempDir
exports.invokeWithNoAsar = invokeWithNoAsar
