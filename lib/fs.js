const nodeRequire = require('./require.js')()
const fs = process.versions.electron ? nodeRequire('original-fs') : require('fs')
const asar = require('./asar.js')
const asarDisk = asar.disk
const path = require('path')
const util = require('util')
const pickle = require('./pickle')
const { splitPath } = require('./util.js')

const originalCreateReadStream = fs.createReadStream

let nextInode = 0
const uid = process.getuid != null ? process.getuid() : 0
const gid = process.getgid != null ? process.getgid() : 0
const fakeTime = new Date()
const asarStatsToFsStats = (stats) => {
  const isFile = !stats.files
  return {
    dev: 1,
    ino: ++nextInode,
    mode: 33188,
    nlink: 1,
    uid: uid,
    gid: gid,
    rdev: 0,
    atime: stats.atime || fakeTime,
    birthtime: stats.birthtime || fakeTime,
    mtime: stats.mtime || fakeTime,
    ctime: stats.ctime || fakeTime,
    size: stats.size,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false
  }
}

let registered = false

const originalFs = Object.create(null)

function overwrite (name, factory) {
  if (!(name in originalFs)) {
    if (name.startsWith('promises.')) {
      const key = name.substring(9)
      const original = fs.promises[key]
      originalFs[name] = original
      fs.promises[key] = factory(original)
    } else {
      const original = fs[name]
      originalFs[name] = original
      fs[name] = factory(original)
    }
  }
}

function revert (name) {
  if (name in originalFs) {
    if (name.startsWith('promises.')) {
      const key = name.substring(9)
      fs.promises[key] = originalFs[name]
      delete originalFs[name]
    } else {
      fs[name] = originalFs[name]
      delete originalFs[name]
    }
  }
}

function cancel () {
  if (!registered) return

  revert('readFileSync')
  revert('readFile')
  revert('promises.readFile')
  revert('createReadStream')
  revert('statSync')
  revert('lstatSync')
  revert('readdirSync')
  revert('existsSync')
  revert('realpathSync')

  registered = false
}

function ENOENT (message) {
  const err = new Error(`ENOENT: ${message}`)
  err.code = 'ENOENT'
  return err
}
function ENOTDIR (message) {
  const err = new Error(`ENOTDIR: ${message}`)
  err.code = 'ENOTDIR'
  return err
}

const bufferToString = (maybeBuffer) => Buffer.isBuffer(maybeBuffer) ? maybeBuffer.toString() : maybeBuffer

function _createReadStream (asarPath, filePath, options, stats) {
  const fd = fs.openSync(asarPath, 'r')

  const sizeBuf = Buffer.alloc(8)
  if (fs.readSync(fd, sizeBuf, 0, 8, null) !== 8) {
    throw new Error('Unable to read header size')
  }

  const sizePickle = pickle.createFromBuffer(sizeBuf)
  const headerSize = sizePickle.createIterator().readUInt32()

  if (!stats) {
    stats = asar.statFile(asarPath, filePath)
  }

  const defaultOption = {
    fd,
    autoClose: true,
    start: 8 + headerSize + parseInt(stats.offset, 10),
    end: 8 + headerSize + parseInt(stats.offset, 10) + stats.size - 1
  }

  if (Object.prototype.toString.call(options) === '[object Object]') {
    if (typeof options.end === 'number') {
      defaultOption.end = defaultOption.start + options.end
      delete options.end
    }
    if (typeof options.start === 'number') {
      defaultOption.start += options.start
      delete options.start
    }
    options = Object.assign({}, defaultOption, options)
  } else {
    options = defaultOption
  }

  return originalCreateReadStream('', options)
}

function overwriteFs () {
  if (registered) return fs

  overwrite('readFileSync', (readFileSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return readFileSync.apply(this, arguments)

      if (!options) {
        options = { encoding: null, flag: 'r' }
      } else if (typeof options === 'string') {
        options = { encoding: options, flag: 'r' }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }

      let content
      try {
        content = asar.extractFile(asarPath, filePath)
      } catch (_error) {
        throw ENOENT('no such file or directory, open \'' + p + '\'')
      }
      if (options.encoding) {
        return content.toString(options.encoding)
      } else {
        return content
      }
    }
  })

  overwrite('readFile', (readFile) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return readFile.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }

      if (!options) {
        options = { encoding: null, flag: 'r' }
      } else if (typeof options === 'string') {
        options = { encoding: options, flag: 'r' }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }

      process.nextTick(() => {
        let stats
        try {
          stats = asar.statFile(asarPath, filePath)
        } catch (_error) {
          callback && callback(ENOENT('no such file or directory, open \'' + p + '\''))
          return
        }

        if (stats.size === 0) {
          const content = Buffer.alloc(0)
          callback && callback(null, options.encoding ? content.toString(options.encoding) : content)
          return
        }

        const data = []
        /** @type {NodeJS.ReadStream} */
        let rs
        try {
          rs = _createReadStream(asarPath, filePath, undefined, stats)
        } catch (err) {
          callback && callback(ENOENT('no such file or directory, open \'' + p + '\''))
          return
        }
        rs.once('error', (err) => { callback && callback(err) })
        rs.once('end', () => {
          const content = Buffer.concat(data)
          if (options.encoding) {
            callback && callback(null, content.toString(options.encoding))
          } else {
            callback && callback(null, content)
          }
        })
        rs.on('data', (chunk) => {
          data.push(chunk)
        })
      })
    }
  })

  const _readFilePromise = util.promisify(fs.readFile)
  overwrite('promises.readFile', (readFilePromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const arr = splitPath(path.resolve(p))
      if (!arr[0] || arr[2] === '') return readFilePromise.apply(this, arguments)
      return _readFilePromise(p, options)
    }
  })

  overwrite('createReadStream', (createReadStream) => {
    return function (p, options) {
      if (!p || (options && options.fd)) return createReadStream.apply(this, arguments)
      p = bufferToString(p)
      const [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return createReadStream.apply(this, arguments)

      try {
        return _createReadStream(asarPath, filePath, options)
      } catch (err) {
        process.nextTick(() => {
          throw ENOENT('no such file or directory, open \'' + p + '\'')
        })
      }
    }
  })

  overwrite('statSync', (statSync) => {
    return function (p) {
      p = bufferToString(p)
      const [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return statSync.apply(this, arguments)
      return asarStatsToFsStats(asar.statFile(asarPath, filePath, true))
    }
  })

  overwrite('lstatSync', (lstatSync) => {
    return function (p) {
      p = bufferToString(p)
      const [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return lstatSync.apply(this, arguments)
      return asarStatsToFsStats(asar.statFile(asarPath, filePath))
    }
  })

  overwrite('readdirSync', (readdirSync) => {
    return function (p) {
      p = bufferToString(p)
      const [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar) return readdirSync.apply(this, arguments)
      const filesystem = asarDisk.readFilesystemSync(asarPath)
      let node
      try {
        node = filesystem.getNode(filePath)
        if (!node) throw new Error()
      } catch (_) {
        throw ENOENT('no such file or directory, asar readdirSync \'' + p + '\'')
      }
      if (node.files) {
        return Object.keys(node.files)
      }
      throw ENOTDIR('not a directory, asar readdirSync \'' + p + '\'')
    }
  })

  overwrite('existsSync', (existsSync) => {
    return function (p) {
      p = bufferToString(p)
      const [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return existsSync.apply(this, arguments)
      try {
        asar.statFile(asarPath, filePath)
        return true
      } catch (_error) {
        return false
      }
    }
  })

  overwrite('realpathSync', (realpathSync) => {
    return function (p) {
      p = bufferToString(p)
      let [isAsar, asarPath, filePath] = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return realpathSync.apply(this, arguments)
      const stat = asar.statFile(asarPath, filePath)
      if (stat.link) filePath = stat.link
      return path.join(realpathSync(asarPath), filePath)
    }
  })

  overwrite('mkdirSync', (mkdirSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const arr = splitPath(path.resolve(p))
      if (!arr[0] || arr[2] === '') return mkdirSync.apply(this, arguments)
      throw ENOTDIR('not a directory, asar mkdirSync \'' + p + '\'')
    }
  })

  overwrite('mkdir', (mkdir) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const arr = splitPath(path.resolve(p))
      if (!arr[0] || arr[2] === '') return mkdir.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      process.nextTick(() => {
        callback && callback(ENOTDIR('not a directory, asar mkdirSync \'' + p + '\''))
      })
    }
  })

  const _mkdirPromise = util.promisify(fs.mkdir)
  overwrite('promises.mkdir', (mkdirPromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const arr = splitPath(path.resolve(p))
      if (!arr[0] || arr[2] === '') return mkdirPromise.apply(this, arguments)
      return _mkdirPromise(p, options)
    }
  })

  registered = true
  return fs
}

module.exports = {
  overwriteFs,
  cancel
}
