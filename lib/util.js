const {
  statSync,
  existsSync,
  chmodSync,
  openSync,
  readSync,
  closeSync,
  writeSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmdirSync
} = require('./fs/index.js')
const path = require('path')
const { tmpdir } = require('os')
const { createHash } = require('crypto')

const envNoAsar = !!(process.env.ELECTRON_NO_ASAR &&
    process.type !== 'browser' &&
    process.type !== 'renderer')
const isAsarDisabled = () => !!(process.noAsar || envNoAsar)

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
 * @param {string | Buffer} archivePath
 * @returns {{ origin: string; isAsar: boolean; asarPath: string; filePath: string }}
 */
function splitPath (archivePath) {
  const r = {
    origin: archivePath,
    isAsar: false,
    asarPath: '',
    filePath: ''
  }
  if (isAsarDisabled()) return r
  if (typeof archivePath !== 'string') return r
  if (archivePath.endsWith('.asar')) {
    if (existsSync(archivePath) && statSync(archivePath).isFile()) {
      r.isAsar = true
      r.asarPath = tryRedirectUnpacked(archivePath)
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
  INVALID_ARCHIVE: 'INVALID_ARCHIVE',
  IS_DIR: 'IS_DIR'
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
    case AsarError.IS_DIR:
      error = new Error('EISDIR, illegal operation on a directory')
      error.code = 'EISDIR'
      error.errno = -21
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

function getModuleConstructor () {
  let Module
  try {
    Module = require('module')
  } catch (_) {}
  return Module
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

const externalFiles = new Map()

function copyFileOut (filesystem, filePath) {
  filePath = path.normalize(filePath)
  const asarPath = filesystem.src
  if (externalFiles.has(filesystem)) {
    const fileCache = externalFiles.get(filesystem)
    if (fileCache[filePath]) {
      return fileCache[filePath]
    }
  }

  let stats
  try {
    stats = filesystem.getFileEx(filePath)
  } catch (error) {
    throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
  }

  if (stats.unpacked) {
    return path.join(asarPath + '.unpacked', filePath)
  }

  const headerSize = filesystem.headerSize

  let hash
  if (stats.integrity && stats.integrity.hash) {
    hash = stats.integrity.hash
  } else {
    const hashObj = createHash('sha256')
    const fd = openSync(asarPath, 'r')
    try {
      readFileChunk(
        fd,
        8 + headerSize + parseInt(stats.offset, 10),
        8 + headerSize + parseInt(stats.offset, 10) + stats.size,
        (chunk, curpos) => {
          hashObj.update(chunk)
        }
      )
    } finally {
      closeSync(fd)
    }
    hash = hashObj.digest('hex')
  }

  const tmpFile = `${path.join(TEMP_DIR, hash)}${path.extname(filePath)}`

  const fd = openSync(asarPath, 'r')
  const wfd = openSync(tmpFile, 'w')
  try {
    readFileChunk(
      fd,
      8 + headerSize + parseInt(stats.offset, 10),
      8 + headerSize + parseInt(stats.offset, 10) + stats.size,
      (chunk, curpos) => {
        writeSync(wfd, chunk, 0, chunk.length)
      }
    )
  } finally {
    closeSync(wfd)
    closeSync(fd)
  }

  if (stats.executable) {
    chmodSync(tmpFile, '755')
  }

  let fileCache
  if (!externalFiles.has(filesystem)) {
    fileCache = Object.create(null)
    externalFiles.set(filesystem, fileCache)
  } else {
    fileCache = externalFiles.get(filesystem)
  }

  fileCache[filePath] = tmpFile
  return tmpFile
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
exports.copyFileOut = copyFileOut
exports.readFileChunk = readFileChunk
exports.TEMP_DIR = TEMP_DIR
exports.initTempDir = initTempDir
exports.invokeWithNoAsar = invokeWithNoAsar
