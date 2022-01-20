const { disk } = require('./asar/index')
const path = require('path')
const { openSync, writeSync, closeSync, chmodSync } = require('./fs/index.js')
const { readFileChunk, TEMP_DIR, splitPath } = require('./util/index.js')
const { createHash } = require('crypto')

/**
 * @typedef {{ size: number; unpacked: boolean; offset: number; executable: boolean; integrity?: { algorithm: 'SHA256'; hash: string }}} AsarFileInfo
 * @typedef {{ size: number; offset: number; isFile: boolean; isDirectory: boolean; isLink: boolean }} AsarFileStat
 */

const kSeparators = process.platform === 'win32' ? /[\\/]/ : /\//

class AsarArchive {
  /**
   * @param {string} asarPath
   * @returns {AsarArchive | null}
   */
  static create (asarPath) {
    const archive = new AsarArchive(asarPath)
    if (!archive.init()) return null
    return archive
  }

  /**
   * @param {string} asarPath
   */
  constructor (asarPath) {
    /** @type {string} */
    this._src = asarPath
    /** @type {number} */
    this._headerSize = 0
    /** @type {null | import('asar').DirectoryRecord} */
    this._header = null
    /** @type {Record<string, string>} */
    this._externalFiles = Object.create(null)
  }

  get headerSize () { return this._headerSize }
  get header () { return this._header }
  get src () { return this._src }

  init () {
    let headerInfo
    try {
      headerInfo = disk.readArchiveHeaderSync(this._src)
    } catch (_) {
      return false
    }
    this._header = headerInfo.header
    this._headerSize = 8 + headerInfo.headerSize
    return true
  }

  /**
   * @param {string} filePath
   * @param {boolean=} followLinks
   * @returns {import('asar').Metadata}
   */
  getNodeFromPath (filePath, followLinks) {
    let node = this._header
    if (!filePath || !node) return node
    const dirs = filePath.split(kSeparators)
    for (let i = 0; i < dirs.length; ++i) {
      const dir = dirs[i]
      if (dir === '.') continue
      node = node.files[dir]
      if (!node) return null
      if (node.link) {
        if (i === dirs.length - 1) {
          if (followLinks) {
            node = this.getNodeFromPath(node.link, followLinks)
          }
        } else {
          node = this.getNodeFromPath(node.link, followLinks)
        }
      }
    }
    return node
  }

  /**
   * @param {string} filePath
   * @returns {AsarFileInfo | false}
   */
  getFileInfo (filePath) {
    if (!this._header) return false
    const node = this.getNodeFromPath(filePath, true)
    if (!node) return false
    const info = new FileInfo()
    if (!fillFileInfoWithNode(info, this._headerSize, node)) return false
    return {
      size: info.size,
      unpacked: info.unpacked,
      offset: info.offset,
      executable: info.executable,
      integrity: info.integrity
    }
  }

  /**
   * @param {import('asar').Metadata} node
   * @returns {AsarFileStat | false}
   */
  statNode (node) {
    if (!node) return false
    const stats = new Stats()
    if (!fillFileStatWithNode(stats, this._headerSize, node)) return false
    return {
      size: stats.size,
      offset: stats.offset,
      isFile: stats.isFile,
      isDirectory: stats.isDirectory,
      isLink: stats.isLink
    }
  }

  /**
   * @param {string} filePath
   * @param {boolean=} followLinks
   * @returns {AsarFileStat | false}
   */
  stat (filePath, followLinks) {
    if (!this._header) return false
    const node = this.getNodeFromPath(filePath, followLinks)
    if (!node) return false
    return this.statNode(node)
  }

  /**
   * @param {string} filePath
   * @returns {string[] | false | 0}
   */
  readdir (filePath) {
    if (!this._header) return false
    const node = this.getNodeFromPath(filePath, true)
    if (!node) return false
    if (node.files == null || typeof node.files !== 'object') return 0
    return Object.keys(node.files)
  }

  /**
   * @param {string} filePath
   * @returns {string | false}
   */
  realpath (filePath) {
    if (!this._header) return false
    const node = this.getNodeFromPath(filePath, false)
    if (!node) return false
    if ('link' in node) return node.link
    return filePath
  }

  /**
   * @param {string} filePath
   * @returns {string}
   */
  getUnpackedPath (filePath) {
    return path.join(this._src + '.unpacked', filePath)
  }

  /**
   * @param {string} filePath
   * @returns {string | false}
   */
  copyFileOut (filePath) {
    if (this._externalFiles[filePath]) {
      return this._externalFiles[filePath]
    }

    if (!this._header) return false
    const node = this.getNodeFromPath(filePath, true)
    if (!node) return false

    if (node.unpacked) {
      return this.getUnpackedPath(filePath)
    }

    const asarPath = this._src

    let hash
    if (node.integrity && node.integrity.hash) {
      hash = node.integrity.hash
    } else {
      const hashObj = createHash('sha256')
      const fd = openSync(asarPath, 'r')
      try {
        readFileChunk(
          fd,
          this._headerSize + parseInt(node.offset, 10),
          this._headerSize + parseInt(node.offset, 10) + node.size,
          (chunk, curpos) => {
            hashObj.update(chunk)
          }
        )
      } catch (_) {
        closeSync(fd)
        return false
      }
      closeSync(fd)
      hash = hashObj.digest('hex')
    }

    const tmpFile = `${path.join(TEMP_DIR, hash)}${path.extname(filePath)}`

    const fd = openSync(asarPath, 'r')
    const wfd = openSync(tmpFile, 'w')
    try {
      readFileChunk(
        fd,
        this._headerSize + parseInt(node.offset, 10),
        this._headerSize + parseInt(node.offset, 10) + node.size,
        (chunk, curpos) => {
          writeSync(wfd, chunk, 0, chunk.length)
        }
      )
    } catch (_) {
      closeSync(wfd)
      closeSync(fd)
      return false
    }
    closeSync(wfd)
    closeSync(fd)

    if (node.executable) {
      chmodSync(tmpFile, '755')
    }

    this._externalFiles[filePath] = tmpFile
    return tmpFile
  }

  /**
   * @template P
   * @template {(fd: number, ...args: [...P]) => any} T
   * @param {T} fn
   * @param  {[...P]} args
   * @returns {ReturnType<T>}
   */
  withOpen (fn, ...args) {
    const fd = openSync(this._src)
    let r
    try {
      r = fn(fd, ...args)
    } catch (err) {
      closeSync(fd)
      throw err
    }
    closeSync(fd)
    return r
  }
}

class FileInfo {
  constructor () {
    this.unpacked = false
    this.executable = false
    this.size = 0
    this.offset = 0
    this.integrity = null
  }
}

class Stats extends FileInfo {
  constructor () {
    super()
    this.isFile = true
    this.isDirectory = false
    this.isLink = false
  }
}

/**
 * @param {FileStat} stats
 * @param {number} headerSize
 * @param {any} node
 * @returns {boolean}
 */
function fillFileStatWithNode (stats, headerSize, node) {
  if ('link' in node) {
    stats.isFile = false
    stats.isLink = true
    return true
  }

  if ('files' in node) {
    stats.isFile = false
    stats.isDirectory = true
    return true
  }

  return fillFileInfoWithNode(stats, headerSize, node)
}

/**
 * @param {FileInfo} info
 * @param {number} headerSize
 * @param {any} node
 * @returns {boolean}
 */
function fillFileInfoWithNode (info, headerSize, node) {
  if ('size' in node) {
    info.size = node.size
  } else {
    return false
  }

  if ('executable' in node) {
    info.executable = node.executable
  }

  if (node.integrity && (node.integrity.algorithm === 'SHA256') && node.integrity.hash) {
    info.integrity = {
      algorithm: 'SHA256',
      hash: node.integrity.hash || ''
    }
  }

  if ('unpacked' in node) {
    info.unpacked = node.unpacked
    if (info.unpacked) {
      return info
    }
  }

  if ('offset' in node) {
    info.offset = parseInt(node.offset, 10)
    info.offset += headerSize
  } else {
    return false
  }

  return true
}

/**
 * @param {string} asarPath
 * @returns {AsarArchive | null}
 */
function createArchive (asarPath) {
  return AsarArchive.create(asarPath)
}

const cachedArchives = new Map()

/**
 * @param {string} asarPath
 * @returns {AsarArchive | null}
 */
function getOrCreateArchive (asarPath) {
  const isCached = cachedArchives.has(asarPath)
  if (isCached) {
    return cachedArchives.get(asarPath)
  }

  const newArchive = createArchive(asarPath)
  if (!newArchive) return null

  cachedArchives.set(asarPath, newArchive)
  return newArchive
}

exports.createArchive = createArchive
exports.splitPath = splitPath
exports.getOrCreateArchive = getOrCreateArchive
