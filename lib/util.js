const { statSync, existsSync } = require('./_fs.js')
const path = require('path')

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

exports.envNoAsar = envNoAsar
exports.isAsarDisabled = isAsarDisabled
exports.tryRedirectUnpacked = tryRedirectUnpacked
exports.splitPath = splitPath
exports.AsarError = AsarError
exports.createError = createError
exports.assertCallback = assertCallback
exports.getModuleConstructor = getModuleConstructor
