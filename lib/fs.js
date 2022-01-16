const nodeRequire = require('./require.js')()
const fs = process.versions.electron ? nodeRequire('original-fs') : require('fs')
const asar = require('./asar.js')
const path = require('path')
const util = require('util')
const pickle = require('./pickle')
const { splitPath } = require('./util.js')

const originalCreateReadStream = fs.createReadStream
const originalCreateWriteStream = fs.createWriteStream
const openSync = fs.openSync
const readSync = fs.readSync
const closeSync = fs.closeSync

let nextInode = 0
const uid = process.getuid != null ? process.getuid() : 0
const gid = process.getgid != null ? process.getgid() : 0
const fakeTime = new Date()
const BigIntFunction = typeof BigInt === 'function' ? BigInt : (n) => n
const num = (n, returnBigInt) => returnBigInt ? BigIntFunction(n) : n
const asarStatsToFsStats = (stats, returnBigInt) => {
  const isDirectory = ('files' in stats)
  const isSymbolicLink = ('link' in stats)
  const isFile = !isDirectory && !isSymbolicLink
  return {
    dev: num(1, returnBigInt),
    ino: num(++nextInode, returnBigInt),
    mode: num(33188, returnBigInt),
    nlink: num(1, returnBigInt),
    uid: num(uid, returnBigInt),
    gid: num(gid, returnBigInt),
    rdev: num(0, returnBigInt),
    atime: stats.atime || fakeTime,
    birthtime: stats.birthtime || fakeTime,
    mtime: stats.mtime || fakeTime,
    ctime: stats.ctime || fakeTime,
    size: num(stats.size || 0, returnBigInt),
    isFile: () => isFile,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => isSymbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false
  }
}
const asarStatsToUvFileType = (stats) => {
  if ('files' in stats) {
    return /* UV_DIRENT_DIR */ 2
  }
  if ('link' in stats) {
    return /* UV_DIRENT_LINK */ 3
  }
  return /* UV_DIRENT_FILE */ 1
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

let fsBinding
try {
  // eslint-disable-next-line node/no-deprecated-api
  fsBinding = process.binding('fs')
} catch (_) {
  fsBinding = {
    internalModuleReadJSON: () => {}
  }
}
let oldInternalModuleReadJSON

function cancel () {
  if (!registered) return

  const methods = Object.keys(originalFs)
  for (let i = 0; i < methods.length; ++i) {
    revert(methods)
  }

  fsBinding.internalModuleReadJSON = oldInternalModuleReadJSON
  oldInternalModuleReadJSON = undefined

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
function EISDIR (message) {
  const err = new Error(`EISDIR: ${message}`)
  err.code = 'EISDIR'
  return err
}
function EACCES (message) {
  const err = new Error(`EACCES: ${message}`)
  err.code = 'EACCES'
  return err
}

const bufferToString = (maybeBuffer) => Buffer.isBuffer(maybeBuffer) ? maybeBuffer.toString() : maybeBuffer

function getHeaderSize (fd) {
  const sizeBuf = Buffer.alloc(8)
  if (readSync(fd, sizeBuf, 0, 8, null) !== 8) {
    throw new Error('Unable to read header size')
  }

  const sizePickle = pickle.createFromBuffer(sizeBuf)
  const headerSize = sizePickle.createIterator().readUInt32()
  return headerSize
}

function _createReadStream (asarPath, filePath, options, stats) {
  const fd = openSync(asarPath, 'r')

  let headerSize
  try {
    headerSize = getHeaderSize(fd)
  } catch (err) {
    closeSync(fd)
    throw err
  }

  if (!stats) {
    try {
      stats = asar.statFile(asarPath, filePath)
    } catch (err) {
      closeSync(fd)
      throw err
    }
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

  try {
    return originalCreateReadStream('', options)
  } catch (err) {
    closeSync(fd)
  }
}

class FileDescriptor extends Number {
  constructor (fd, start, end) {
    super(fd)
    this.fd = fd
    this.start = start || 0
    this.end = end || 0
    this.pos = start || 0
  }
}

function assertCallback (callback) {
  if (typeof callback !== 'function') {
    throw new TypeError(`Callback must be a function. Received ${typeof callback}`)
  }
}

function overwriteFs () {
  if (registered) return fs

  oldInternalModuleReadJSON = fsBinding.internalModuleReadJSON
  fsBinding.internalModuleReadJSON = function (p) {
    const { isAsar, pathInAsar } = splitPath(path.resolve(p))
    if (!isAsar || pathInAsar === '') return oldInternalModuleReadJSON.apply(this, arguments)
    return require('./module.js').internalModuleReadJSON(p)
  }

  overwrite('readFileSync', (readFileSync) => {
    return function (p, options) {
      if (process.noAsar) return readFileSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return readFileSync.apply(this, arguments)

      if (!options) {
        options = { encoding: null, flag: 'r' }
      } else if (typeof options === 'string') {
        options = { encoding: options, flag: 'r' }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }

      let content
      try {
        content = asar.extractFile(asarPath, pathInAsar)
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
      if (process.noAsar) return readFile.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return readFile.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

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
          stats = asar.statFile(asarPath, pathInAsar)
        } catch (_error) {
          callback(ENOENT('no such file or directory, open \'' + p + '\''))
          return
        }

        if (stats.size === 0) {
          const content = Buffer.alloc(0)
          callback(null, options.encoding ? content.toString(options.encoding) : content)
          return
        }

        const data = []
        /** @type {NodeJS.ReadStream} */
        let rs
        try {
          rs = _createReadStream(asarPath, pathInAsar, undefined, stats)
        } catch (err) {
          callback(ENOENT('no such file or directory, open \'' + p + '\''))
          return
        }
        rs.once('error', (err) => { callback(err) })
        rs.once('end', () => {
          const content = Buffer.concat(data)
          if (options.encoding) {
            callback(null, content.toString(options.encoding))
          } else {
            callback(null, content)
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
      if (process.noAsar) return readFilePromise.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return readFilePromise.apply(this, arguments)
      return _readFilePromise(p, options)
    }
  })

  overwrite('createReadStream', (createReadStream) => {
    return function (p, options) {
      if (process.noAsar || !p || (options && options.fd)) return createReadStream.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return createReadStream.apply(this, arguments)

      try {
        return _createReadStream(asarPath, pathInAsar, options)
      } catch (err) {
        process.nextTick(() => {
          throw ENOENT('no such file or directory, open \'' + p + '\'')
        })
      }
    }
  })

  overwrite('statSync', (statSync) => {
    return function (p, options) {
      if (process.noAsar) return statSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar) return statSync.apply(this, arguments)
      try {
        return asarStatsToFsStats(asar.statFile(asarPath, pathInAsar, true), options && options.bigint)
      } catch (err) {
        throw ENOENT('no such file or directory, asar statSync \'' + p + '\'')
      }
    }
  })

  overwrite('lstatSync', (lstatSync) => {
    return function (p, options) {
      if (process.noAsar) return lstatSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar) return lstatSync.apply(this, arguments)
      try {
        return asarStatsToFsStats(asar.statFile(asarPath, pathInAsar, false), options && options.bigint)
      } catch (err) {
        throw ENOENT('no such file or directory, asar lstatSync \'' + p + '\'')
      }
    }
  })

  overwrite('lstat', (lstat) => {
    return function (p, options, callback) {
      if (process.noAsar) return lstat.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar) return lstat.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      process.nextTick(() => {
        let stat
        try {
          stat = asarStatsToFsStats(asar.statFile(asarPath, pathInAsar, false), options && options.bigint)
        } catch (err) {
          callback(ENOENT('no such file or directory, asar lstatSync \'' + p + '\''))
          return
        }
        callback(null, stat)
      })
    }
  })

  const _lstatPromise = util.promisify(fs.lstat)
  overwrite('promises.lstat', (lstatPromise) => {
    return function (p, options) {
      if (process.noAsar) return lstatPromise.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar } = splitPath(path.resolve(p))
      if (!isAsar) return lstatPromise.apply(this, arguments)
      return _lstatPromise(p, options)
    }
  })

  overwrite('readdirSync', (readdirSync) => {
    return function (p, options) {
      if (process.noAsar) return readdirSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar) return readdirSync.apply(this, arguments)
      let node
      try {
        node = asar.statFile(asarPath, pathInAsar, true)
      } catch (_) {
        throw ENOENT('no such file or directory, asar readdirSync \'' + p + '\'')
      }
      if (node.files) {
        const names = Object.keys(node.files)
        if (options && options.withFileTypes) {
          const r = []
          for (let i = 0; i < names.length; ++i) {
            const name = names[i]
            r[i] = new fs.Dirent(name, asarStatsToUvFileType(node.files[name]))
          }
          return r
        } else {
          return names
        }
      }
      throw ENOTDIR('not a directory, asar readdirSync \'' + p + '\'')
    }
  })

  overwrite('readdir', (readdir) => {
    return function (p, options, callback) {
      if (process.noAsar) return readdir.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar) return readdir.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      process.nextTick(() => {
        let node
        try {
          node = asar.statFile(asarPath, pathInAsar, true)
        } catch (_) {
          callback(ENOENT('no such file or directory, asar readdir \'' + p + '\''))
          return
        }
        if (node.files) {
          const names = Object.keys(node.files)
          if (options && options.withFileTypes) {
            const r = []
            for (let i = 0; i < names.length; ++i) {
              const name = names[i]
              r[i] = new fs.Dirent(name, asarStatsToUvFileType(node.files[name]))
            }
            return callback(null, r)
          } else {
            return callback(null, names)
          }
        }
        callback(ENOTDIR('not a directory, asar readdir \'' + p + '\''))
      })
    }
  })

  const _readdirPromise = util.promisify(fs.readdir)
  overwrite('promises.readdir', (readdirPromise) => {
    return function (p, options) {
      if (process.noAsar) return readdirPromise.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar } = splitPath(path.resolve(p))
      if (!isAsar) return readdirPromise.apply(this, arguments)
      return _readdirPromise(p, options)
    }
  })

  overwrite('existsSync', (existsSync) => {
    return function (p) {
      if (process.noAsar) return existsSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return existsSync.apply(this, arguments)
      try {
        asar.statFile(asarPath, pathInAsar)
        return true
      } catch (_error) {
        return false
      }
    }
  })

  overwrite('exists', (oldExists) => {
    function exists (p, callback) {
      if (process.noAsar) return oldExists.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return oldExists.apply(this, arguments)
      assertCallback(callback)
      try {
        asar.statFile(asarPath, pathInAsar)
      } catch (_error) {
        // eslint-disable-next-line node/no-callback-literal
        callback(false)
        return
      }
      // eslint-disable-next-line node/no-callback-literal
      callback(true)
    }
    Object.defineProperty(exists, util.promisify.custom, {
      value: oldExists[util.promisify.custom]
    })
    return exists
  })

  overwrite('realpathSync', (oldRealpathSync) => {
    function _realpathSync (p, asarPath, pathInAsar, options) {
      if (!options) {
        options = { encoding: 'utf8' }
      } else if (typeof options === 'string') {
        options = { encoding: options }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }
      let stat
      try {
        stat = asar.statFile(asarPath, pathInAsar, false)
      } catch (err) {
        throw ENOENT('no such file or directory, asar realpathSync \'' + p + '\'')
      }
      if (stat.link) pathInAsar = stat.link
      const result = path.join(oldRealpathSync(asarPath), pathInAsar)
      if (options.encoding === 'utf8') {
        return result
      }
      if (options.encoding === 'buffer') {
        return Buffer.from(result)
      }
      return Buffer.from(result).toString(options.encoding)
    }

    function realpathSync (p, options) {
      if (process.noAsar) return oldRealpathSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return oldRealpathSync.apply(this, arguments)
      return _realpathSync(p, asarPath, pathInAsar, options)
    }
    realpathSync.native = function (p, options) {
      if (process.noAsar) return oldRealpathSync.native.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return oldRealpathSync.native.apply(this, arguments)
      return _realpathSync(p, asarPath, pathInAsar, options)
    }
    return realpathSync
  })

  overwrite('realpath', (oldRealpath) => {
    const _realpath = function (p, asarPath, pathInAsar, options, callback) {
      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)
      if (!options) {
        options = { encoding: 'utf8' }
      } else if (typeof options === 'string') {
        options = { encoding: options }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }
      process.nextTick(() => {
        let stat
        try {
          stat = asar.statFile(asarPath, pathInAsar, false)
        } catch (err) {
          callback(ENOENT('no such file or directory, asar realpath \'' + p + '\''))
          return
        }
        if (stat.link) pathInAsar = stat.link
        oldRealpath(asarPath, (err, real) => {
          if (err) {
            callback(err)
            return
          }
          const result = path.join(real, pathInAsar)
          if (options.encoding === 'utf8') {
            return callback(null, result)
          }
          if (options.encoding === 'buffer') {
            return callback(null, Buffer.from(result))
          }
          return callback(Buffer.from(result).toString(options.encoding))
        })
      })
    }
    function realpath (p, options, callback) {
      if (process.noAsar) return oldRealpath.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return oldRealpath.apply(this, arguments)
      return _realpath(p, asarPath, pathInAsar, options, callback)
    }

    realpath.native = function (p, options, callback) {
      if (process.noAsar) return oldRealpath.native.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return oldRealpath.native.apply(this, arguments)
      return _realpath(p, asarPath, pathInAsar, options, callback)
    }

    return realpath
  })

  const _realpathPromise = util.promisify(fs.realpath)
  overwrite('promises.realpath', (realpathPromise) => {
    return function (p, options) {
      if (process.noAsar) return realpathPromise.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar } = splitPath(path.resolve(p))
      if (!isAsar) return realpathPromise.apply(this, arguments)
      return _realpathPromise(p, options)
    }
  })

  overwrite('mkdirSync', (mkdirSync) => {
    return function (p, options) {
      if (process.noAsar) return mkdirSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return mkdirSync.apply(this, arguments)
      throw ENOTDIR('not a directory, asar mkdirSync \'' + p + '\'')
    }
  })

  overwrite('mkdir', (mkdir) => {
    return function (p, options, callback) {
      if (process.noAsar) return mkdir.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return mkdir.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)
      process.nextTick(() => {
        callback(ENOTDIR('not a directory, asar mkdirSync \'' + p + '\''))
      })
    }
  })

  const _mkdirPromise = util.promisify(fs.mkdir)
  overwrite('promises.mkdir', (mkdirPromise) => {
    return function (p, options) {
      if (process.noAsar) return mkdirPromise.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return mkdirPromise.apply(this, arguments)
      return _mkdirPromise(p, options)
    }
  })

  overwrite('copyFileSync', (copyFileSync) => {
    return function (src, dest, mode) {
      if (process.noAsar) return copyFileSync.apply(this, arguments)
      src = bufferToString(src)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(src))
      if (!isAsar || pathInAsar === '') return copyFileSync.apply(this, arguments)

      const fd = openSync(asarPath, 'r')

      let headerSize
      try {
        headerSize = getHeaderSize(fd)
      } catch (err) {
        closeSync(fd)
        throw err
      }

      let stats
      try {
        stats = asar.statFile(asarPath, pathInAsar)
      } catch (err) {
        closeSync(fd)
        throw ENOENT('no such file or directory, asar copyFileSync \'' + src + '\'')
      }

      if (stats.unpacked) {
        closeSync(fd)
        return copyFileSync.call(this, path.join(asarPath + '.unpacked', pathInAsar), dest, mode)
      }

      const range = [8 + headerSize + parseInt(stats.offset, 10), 8 + headerSize + parseInt(stats.offset, 10) + stats.size]
      const BUFFER_SIZE = 64 * 1024
      const buffer = Buffer.alloc(BUFFER_SIZE)
      let bytesRead = 0
      let pos = range[0]

      dest = bufferToString(dest)
      const wfd = openSync(dest, 'w')

      try {
        while (pos !== range[1]) {
          const left = range[1] - pos
          if (left < BUFFER_SIZE) {
            bytesRead = readSync(fd, buffer, 0, left, pos)
          } else {
            bytesRead = readSync(fd, buffer, 0, BUFFER_SIZE, pos)
          }
          pos += bytesRead
          fs.writeSync(wfd, buffer, 0, bytesRead)
        }
      } finally {
        closeSync(fd)
        closeSync(wfd)
      }
    }
  })

  overwrite('copyFile', (copyFile) => {
    return function (src, dest, mode, callback) {
      if (process.noAsar) return copyFile.apply(this, arguments)
      src = bufferToString(src)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(src))
      if (!isAsar || pathInAsar === '') return copyFile.apply(this, arguments)

      if (typeof mode === 'function') {
        callback = mode
        mode = 0
      }
      assertCallback(callback)

      process.nextTick(() => {
        let stats
        try {
          stats = asar.statFile(asarPath, pathInAsar)
        } catch (_error) {
          callback(ENOENT('no such file or directory, open \'' + src + '\''))
          return
        }

        if (stats.unpacked) {
          return copyFile.call(this, path.join(asarPath + '.unpacked', pathInAsar), dest, mode, callback)
        }

        dest = bufferToString(dest)

        if (stats.size === 0) {
          try {
            const wfd = openSync(dest, 'w')
            closeSync(wfd)
          } catch (err) {
            callback(err)
            return
          }
          callback(null)
          return
        }

        /** @type {NodeJS.ReadStream} */
        let rs
        try {
          rs = _createReadStream(asarPath, pathInAsar, undefined, stats)
        } catch (err) {
          callback(ENOENT('no such file or directory, open \'' + src + '\''))
          return
        }
        const ws = originalCreateWriteStream.call(fs, dest, { flags: 'w' })
        ws.once('error', callback)
        ws.on('close', () => {
          callback(null)
        })
        rs.once('error', callback)
        rs.pipe(ws)
      })
    }
  })

  const _copyFilePromise = util.promisify(fs.copyFile)
  overwrite('promises.copyFile', (copyFilePromise) => {
    return function (src, dest, mode) {
      if (process.noAsar) return copyFilePromise.apply(this, arguments)
      src = bufferToString(src)
      const { isAsar, pathInAsar } = splitPath(path.resolve(src))
      if (!isAsar || pathInAsar === '') return copyFilePromise.apply(this, arguments)
      return _copyFilePromise(src, dest, mode)
    }
  })

  overwrite('accessSync', (accessSync) => {
    return function (p, mode) {
      if (process.noAsar) return accessSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return accessSync.apply(this, arguments)

      mode = mode || fs.constants.F_OK

      let stats
      try {
        stats = asar.statFile(asarPath, pathInAsar, true)
      } catch (err) {
        throw ENOENT('no such file or directory, asar accessSync \'' + p + '\'')
      }

      if (stats.unpacked) {
        return accessSync.apply(this, [path.join(asarPath + '.unpacked', pathInAsar), mode])
      }

      if (mode & fs.constants.W_OK) {
        throw EACCES('permission denied')
      }
    }
  })

  overwrite('access', (access) => {
    return function (p, mode, callback) {
      if (process.noAsar) return access.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return access.apply(this, arguments)

      if (typeof mode === 'function') {
        callback = mode
        mode = fs.constants.F_OK
      }
      assertCallback(callback)

      mode = mode || fs.constants.F_OK

      process.nextTick(() => {
        let stats
        try {
          stats = asar.statFile(asarPath, pathInAsar, true)
        } catch (err) {
          return callback(ENOENT('no such file or directory, asar access \'' + p + '\''))
        }

        if (stats.unpacked) {
          return access.apply(this, [path.join(asarPath + '.unpacked', pathInAsar), mode, callback])
        }

        if (mode & fs.constants.W_OK) {
          return callback(EACCES('permission denied'))
        }

        callback(null)
      })
    }
  })

  const _accessPromise = util.promisify(fs.access)
  overwrite('promises.access', (accessPromise) => {
    return function (p, options) {
      if (process.noAsar) return accessPromise.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return accessPromise.apply(this, arguments)
      return _accessPromise(p, options)
    }
  })

  overwrite('openSync', (openSync) => {
    return function (p, flags, mode) {
      if (process.noAsar) return openSync.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return openSync.apply(this, arguments)

      let stats
      try {
        stats = asar.statFile(asarPath, pathInAsar, true)
      } catch (err) {
        throw ENOENT('no such file or directory, asar openSync \'' + p + '\'')
      }

      if (stats.files) {
        throw EISDIR('illegal operation on a directory')
      }

      if (stats.unpacked) {
        return openSync.apply(this, [path.join(asarPath + '.unpacked', pathInAsar), flags, mode])
      }

      flags = 'r'
      const fd = openSync.apply(this, [asarPath, flags, mode])
      let headerSize
      try {
        headerSize = getHeaderSize(fd)
      } catch (err) {
        throw ENOENT('no such file or directory, asar openSync \'' + p + '\'')
      }
      const wrappedFd = new FileDescriptor(fd, 8 + headerSize + parseInt(stats.offset, 10), 8 + headerSize + parseInt(stats.offset, 10) + stats.size)
      return wrappedFd
    }
  })

  overwrite('open', (open) => {
    return function (p, flags, mode, callback) {
      if (process.noAsar) return open.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return open.apply(this, arguments)

      if (typeof flags === 'function') {
        callback = flags
        flags = 'r'
        mode = 0o666
      } else if (typeof mode === 'function') {
        callback = mode
        mode = 0o666
      }
      assertCallback(callback)

      process.nextTick(() => {
        let stats
        try {
          stats = asar.statFile(asarPath, pathInAsar, true)
        } catch (err) {
          return callback(ENOENT('no such file or directory, asar open \'' + p + '\''))
        }

        if (stats.files) {
          return callback(EISDIR('illegal operation on a directory'))
        }

        if (stats.unpacked) {
          return open.apply(this, [path.join(asarPath + '.unpacked', pathInAsar), flags, mode, callback])
        }

        flags = 'r'
        open.apply(this, [asarPath, flags, mode, (err, fd) => {
          if (err) {
            return callback(err)
          }
          let headerSize
          try {
            headerSize = getHeaderSize(fd)
          } catch (err) {
            return callback(ENOENT('no such file or directory, asar openSync \'' + p + '\''))
          }
          const wrappedFd = new FileDescriptor(fd, 8 + headerSize + parseInt(stats.offset, 10), 8 + headerSize + parseInt(stats.offset, 10) + stats.size)
          callback(null, wrappedFd)
        }])
      })
    }
  })

  overwrite('promises.open', (openPromise) => {
    return function (p, flags, mode) {
      if (process.noAsar) return openPromise.apply(this, arguments)
      p = bufferToString(p)
      const { isAsar, asarPath, pathInAsar } = splitPath(path.resolve(p))
      if (!isAsar || pathInAsar === '') return openPromise.apply(this, arguments)
      return new Promise((resolve, reject) => {
        process.nextTick(() => {
          let stats
          try {
            stats = asar.statFile(asarPath, pathInAsar, true)
          } catch (err) {
            return reject(ENOENT('no such file or directory, asar promises.open \'' + p + '\''))
          }

          if (stats.files) {
            return reject(EISDIR('illegal operation on a directory'))
          }

          if (stats.unpacked) {
            return resolve(openPromise.apply(this, [path.join(asarPath + '.unpacked', pathInAsar), flags, mode]))
          }

          flags = 'r'
          openPromise.apply(this, [asarPath, flags, mode]).then((fh) => {
            const fd = fh.fd
            let headerSize
            try {
              headerSize = getHeaderSize(fd)
            } catch (err) {
              return reject(ENOENT('no such file or directory, asar promises.open \'' + p + '\''))
            }
            const wrappedFd = new FileDescriptor(fd, 8 + headerSize + parseInt(stats.offset, 10), 8 + headerSize + parseInt(stats.offset, 10) + stats.size)
            Object.defineProperty(fh, 'fd', {
              configurable: true,
              get () {
                return wrappedFd
              }
            })
            const oldRead = fh.read
            fh.read = function (buffer, offset, length, position) {
              const fd = this.fd
              if (fd instanceof FileDescriptor) {
                if (typeof buffer === 'object' && buffer !== null && !Buffer.isBuffer(buffer)) {
                  const options = buffer
                  buffer = options.buffer || Buffer.alloc(16384)
                  offset = options.offset || 0
                  length = options.length != null ? options.length : buffer.byteLength
                  position = options.position != null ? options.position : null
                }
                position = position == null ? fd.pos : (position + fd.start)
                if (position + length >= fd.end) {
                  length = fd.end - position
                }
                if (length > buffer.byteLength) {
                  throw new RangeError(`The value of "length" is out of range. It must be <= ${buffer.byteLength}. Received ${length}`)
                }
                return new Promise((resolve, reject) => {
                  fs.read(fd.fd, buffer, offset, length, position, (err, bytesRead) => {
                    if (err) return reject(err)
                    fd.pos = position + bytesRead
                    resolve(bytesRead)
                  })
                })
              } else {
                return oldRead.apply(this, arguments)
              }
            }
            const oldClose = fh.close
            fh.close = function () {
              const fd = this.fd
              if (fd instanceof FileDescriptor) {
                const realFd = fd.fd
                fd.fd = null
                fd.start = 0
                fd.end = 0
                fd.pos = 0
                Object.defineProperty(this, 'fd', {
                  configurable: true,
                  get () {
                    return realFd
                  }
                })
                return oldClose.apply(this, arguments)
              } else {
                return oldClose.apply(this, arguments)
              }
            }
            resolve(fh)
          }).catch(reject)
        })
      })
    }
  })

  overwrite('readSync', (readSync) => {
    return function (fd, buffer, offset, length, position) {
      if (fd instanceof FileDescriptor) {
        if (typeof offset === 'object' && offset !== null) {
          length = offset.length != null ? offset.length : buffer.byteLength
          position = offset.position != null ? offset.position : null
          offset = offset.offset || 0
        }
        position = position == null ? fd.pos : (position + fd.start)
        if (position + length >= fd.end) {
          length = fd.end - position
        }
        if (length > buffer.byteLength) {
          throw new RangeError(`The value of "length" is out of range. It must be <= ${buffer.byteLength}. Received ${length}`)
        }
        const bytesRead = readSync.apply(this, [fd.fd, buffer, offset, length, position])
        fd.pos = position + bytesRead
        return bytesRead
      } else {
        return readSync.apply(this, arguments)
      }
    }
  })

  overwrite('read', (read) => {
    return function (fd, buffer, offset, length, position, callback) {
      if (fd instanceof FileDescriptor) {
        if (typeof buffer === 'function') {
          callback = buffer
          buffer = Buffer.alloc(16384)
          offset = 0
          length = buffer.byteLength
          position = null
        } else if (Object.prototype.toString.call(buffer) === '[object Object]') {
          callback = offset
          const options = buffer
          buffer = options.buffer || Buffer.alloc(16384)
          offset = options.offset || 0
          length = options.length != null ? options.length : buffer.byteLength
          position = options.position != null ? options.position : null
        }
        assertCallback(callback)

        position = position == null ? fd.pos : (position + fd.start)
        if (position + length >= fd.end) {
          length = fd.end - position
        }
        if (length > buffer.byteLength) {
          process.nextTick(() => {
            callback(new RangeError(`The value of "length" is out of range. It must be <= ${buffer.byteLength}. Received ${length}`))
          })
          return
        }
        read.apply(this, [fd.fd, buffer, offset, length, position, (err, bytesRead) => {
          if (err) return callback(err)
          fd.pos = position + bytesRead
          callback(null, bytesRead)
        }])
      } else {
        return read.apply(this, arguments)
      }
    }
  })

  overwrite('closeSync', (closeSync) => {
    return function (fd) {
      if (fd instanceof FileDescriptor) {
        const realFd = fd.fd
        fd.fd = null
        fd.start = 0
        fd.end = 0
        fd.pos = 0
        return closeSync.apply(this, [realFd])
      } else {
        return closeSync.apply(this, arguments)
      }
    }
  })

  overwrite('close', (close) => {
    return function (fd, callback) {
      if (fd instanceof FileDescriptor) {
        const realFd = fd.fd
        fd.fd = null
        fd.start = 0
        fd.end = 0
        fd.pos = 0
        return close.apply(this, [realFd, callback])
      } else {
        return close.apply(this, arguments)
      }
    }
  })

  registered = true
  return fs
}

module.exports = {
  overwriteFs,
  cancel
}
