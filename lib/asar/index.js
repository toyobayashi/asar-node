// Extract from asar 2.0.3
const path = require('path')
const fs = require('../fs/index.js')
const pickle = require('./pickle')
const openSync = fs.openSync
const readSync = fs.readSync
const closeSync = fs.closeSync

const kSeparators = process.platform === 'win32' ? /[\\/]/ : /\//

class Filesystem {
  constructor (src) {
    this.src = path.resolve(src)
    this.header = { files: {} }
    this.headerSize = 0
    // this.offset = BigInt(0)
  }

  searchNodeFromDirectory (p) {
    let json = this.header
    const dirs = p.split(kSeparators)
    for (const dir of dirs) {
      if (dir !== '.') {
        json = json.files[dir]
      }
    }
    return json
  }

  getNode (p) {
    const node = this.searchNodeFromDirectory(path.dirname(p))
    const name = path.basename(p)
    if (name) {
      return node.files[name]
    } else {
      return node
    }
  }

  getFile (p, followLinks) {
    followLinks = typeof followLinks === 'undefined' ? true : followLinks
    const info = this.getNode(p)

    // if followLinks is false we don't resolve symlinks
    if (info.link && followLinks) {
      return this.getFile(info.link)
    } else {
      return info
    }
  }

  getFileEx (p, followLinks) {
    followLinks = typeof followLinks === 'undefined' ? true : followLinks
    let json = this.header
    if (!p) return json
    const dirs = p.split(kSeparators)
    for (let i = 0; i < dirs.length; ++i) {
      const dir = dirs[i]
      if (dir !== '.') {
        json = json.files[dir]
      }
      // if (!json) return json
      if (json.link) {
        if (i === dirs.length - 1) {
          if (followLinks) {
            json = this.getFileEx(json.link, followLinks)
          }
        } else {
          json = this.getFileEx(json.link, followLinks)
        }
      }
    }
    return json
  }
}

/** @type {Record<string, Filesystem>} */
const filesystemCache = Object.create(null)

function extractFile (archive, filename) {
  const filesystem = readFilesystemSync(archive)
  return readFileSync(filesystem, filename, filesystem.getFileEx(filename))
}

function statFile (archive, filename, followLinks) {
  const filesystem = readFilesystemSync(archive)
  return filesystem.getFileEx(filename, followLinks)
}

/**
 * @param {Filesystem} filesystem
 * @param {string} filename
 * @param {import('asar').FileMetadata} info
 * @returns {Buffer}
 */
function readFileSync (filesystem, filename, info) {
  let buffer = Buffer.alloc(info.size)
  if (info.size <= 0) { return buffer }
  if (info.unpacked) {
    // it's an unpacked file, copy it.
    buffer = fs.readFileSync(path.join(`${filesystem.src}.unpacked`, filename))
  } else {
    // Node throws an exception when reading 0 bytes into a 0-size buffer,
    // so we short-circuit the read in this case.
    const fd = openSync(filesystem.src, 'r')
    try {
      const offset = 8 + filesystem.headerSize + parseInt(info.offset)
      readSync(fd, buffer, 0, info.size, offset)
    } finally {
      closeSync(fd)
    }
  }
  return buffer
}

function readArchiveHeaderSync (archive) {
  const fd = openSync(archive, 'r')
  let size
  let headerBuf
  try {
    const sizeBuf = Buffer.alloc(8)
    if (readSync(fd, sizeBuf, 0, 8, null) !== 8) {
      throw new Error('Unable to read header size')
    }

    const sizePickle = pickle.createFromBuffer(sizeBuf)
    size = sizePickle.createIterator().readUInt32()
    headerBuf = Buffer.alloc(size)
    if (readSync(fd, headerBuf, 0, size, null) !== size) {
      throw new Error('Unable to read header')
    }
  } finally {
    closeSync(fd)
  }

  const headerPickle = pickle.createFromBuffer(headerBuf)
  const header = headerPickle.createIterator().readString()
  return { header: JSON.parse(header), headerSize: size }
}

function readFilesystemSync (archive) {
  if (!filesystemCache[archive]) {
    const header = readArchiveHeaderSync(archive)
    const filesystem = new Filesystem(archive)
    filesystem.header = header.header
    filesystem.headerSize = header.headerSize
    filesystemCache[archive] = filesystem
  }
  return filesystemCache[archive]
}

exports.extractFile = extractFile
exports.statFile = statFile
exports.disk = {
  readFilesystemSync,
  readFileSync
}
exports.Filesystem = Filesystem
