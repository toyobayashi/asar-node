// Extract from asar 2.0.3

const { openSync, readSync, closeSync } = require('../fs/index.js')
const pickle = require('./pickle')

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

const disk = {
  readArchiveHeaderSync
}

exports.disk = disk
