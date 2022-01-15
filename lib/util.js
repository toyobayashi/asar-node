const { statSync, existsSync } = require('fs')
const path = require('path')

/**
 * @param {string} filepath
 * @returns {string}
 */
function tryRedirectUnpacked (filepath) {
  const dir = path.dirname(filepath)
  const dirInfo = splitPath(dir)
  if (dirInfo.isAsar) {
    return path.join(dirInfo.asarPath + '.unpacked', dirInfo.pathInAsar, path.basename(filepath))
  } else {
    return filepath
  }
}

/**
 * @param {string} p
 * @returns {{ origin: string; isAsar: boolean; asarPath: string; pathInAsar: string }}
 */
function splitPath (p) {
  const r = {
    origin: p,
    isAsar: false,
    asarPath: '',
    pathInAsar: ''
  }
  if (typeof p !== 'string') return r
  if (p.endsWith('.asar')) {
    if (existsSync(p) && statSync(p).isFile()) {
      r.isAsar = true
      r.asarPath = tryRedirectUnpacked(p)
    }
    return r
  }
  const indexWindows = p.lastIndexOf('.asar\\')
  const indexPosix = p.lastIndexOf('.asar/')
  if (indexWindows === -1 && indexPosix === -1) return r
  const index = indexPosix === -1 ? indexWindows : indexPosix

  const archive = p.substring(0, index + 5)

  if (existsSync(archive) && statSync(archive).isFile()) {
    r.isAsar = true
    r.asarPath = tryRedirectUnpacked(archive)
    r.pathInAsar = p.substring(index + 6)
  }

  return r
}

exports.splitPath = splitPath
exports.tryRedirectUnpacked = tryRedirectUnpacked
