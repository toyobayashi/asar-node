const fs = require('./_fs.js')
const asar = require('./asar.js')
const path = require('path')
const util = require('util')
const pickle = require('./pickle')
const { splitPath, assertCallback, AsarError, createError, copyFileOut, readFileChunk } = require('./util.js')

const originalCreateReadStream = fs.createReadStream
const originalCreateWriteStream = fs.createWriteStream
const openSync = fs.openSync
const readSync = fs.readSync
const closeSync = fs.closeSync
const oldRead = fs.read
const { Stats, constants } = fs

const supportBigInt = typeof BigInt === 'function'
const kNsPerMsBigInt = supportBigInt ? BigInt(10) ** BigInt(6) : 0

const BigIntStats = (() => {
  if (!supportBigInt) return undefined

  function dateFromMs (ms) {
    return new Date(Number(ms) + 0.5)
  }

  const StatsBase = Object.getPrototypeOf(Stats)
  class BigIntStats extends StatsBase {
    constructor (dev, mode, nlink, uid, gid, rdev, blksize,
      ino, size, blocks,
      atimeNs, mtimeNs, ctimeNs, birthtimeNs) {
      super(dev, mode, nlink, uid, gid, rdev, blksize,
        ino, size, blocks)

      this.atimeMs = atimeNs / kNsPerMsBigInt
      this.mtimeMs = mtimeNs / kNsPerMsBigInt
      this.ctimeMs = ctimeNs / kNsPerMsBigInt
      this.birthtimeMs = birthtimeNs / kNsPerMsBigInt
      this.atimeNs = atimeNs
      this.mtimeNs = mtimeNs
      this.ctimeNs = ctimeNs
      this.birthtimeNs = birthtimeNs
      this.atime = dateFromMs(this.atimeMs)
      this.mtime = dateFromMs(this.mtimeMs)
      this.ctime = dateFromMs(this.ctimeMs)
      this.birthtime = dateFromMs(this.birthtimeMs)
    }

    _checkModeProperty (property) {
      if (process.platform === 'win32' && (property === /* S_IFIFO */ 4096 || property === /* S_IFBLK */ 24576 ||
        property === /* S_IFSOCK */ 49152)) {
        return false // Some types are not available on Windows
      }
      return (this.mode & BigInt(/* S_IFMT */ 61440)) === BigInt(property)
    }
  }

  return BigIntStats
})()

let nextInode = 0
const uid = process.getuid != null ? process.getuid() : 0
const gid = process.getgid != null ? process.getgid() : 0
const fakeTime = new Date()
const asarStatsToFsStats = (stats, returnBigInt) => {
  let mode = constants.S_IROTH ^ constants.S_IRGRP ^ constants.S_IRUSR ^ constants.S_IWUSR

  const isDirectory = ('files' in stats)
  const isSymbolicLink = ('link' in stats)
  const isFile = !isDirectory && !isSymbolicLink

  if (isFile) {
    mode ^= constants.S_IFREG
  } else if (isDirectory) {
    mode ^= constants.S_IFDIR
  } else if (isSymbolicLink) {
    mode ^= constants.S_IFLNK
  }

  if (returnBigInt && BigIntStats) {
    return new BigIntStats(
      BigInt(1), // dev
      BigInt(mode), // mode
      BigInt(1), // nlink
      BigInt(uid),
      BigInt(gid),
      BigInt(0), // rdev
      undefined, // blksize
      BigInt(++nextInode), // ino
      BigInt(stats.size || 0),
      undefined, // blocks,
      BigInt(fakeTime.getTime()) * kNsPerMsBigInt, // atim_msec
      BigInt(fakeTime.getTime()) * kNsPerMsBigInt, // mtim_msec
      BigInt(fakeTime.getTime()) * kNsPerMsBigInt, // ctim_msec
      BigInt(fakeTime.getTime()) * kNsPerMsBigInt // birthtim_msec
    )
  }

  return new Stats(
    1, // dev
    mode, // mode
    1, // nlink
    uid,
    gid,
    0, // rdev
    undefined, // blksize
    ++nextInode, // ino
    stats.size || 0,
    undefined, // blocks,
    fakeTime.getTime(), // atim_msec
    fakeTime.getTime(), // mtim_msec
    fakeTime.getTime(), // ctim_msec
    fakeTime.getTime() // birthtim_msec
  )
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

/* function _createReadStream (asarPath, filePath, options, stats) {
  const filesystem = asar.disk.readFilesystemSync(asarPath)

  if (!stats) {
    stats = filesystem.getFileEx(filePath)
  }

  const headerSize = filesystem.headerSize
  const fd = openSync(asarPath, 'r')

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
} */

function overwriteFs () {
  if (registered) return fs

  oldInternalModuleReadJSON = fsBinding.internalModuleReadJSON
  fsBinding.internalModuleReadJSON = function (p) {
    const { isAsar, filePath } = splitPath(path.resolve(p))
    if (!isAsar || filePath === '') return oldInternalModuleReadJSON.apply(this, arguments)
    return require('./module.js').internalModuleReadJSON(p)
  }

  overwrite('readFileSync', (readFileSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
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
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
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
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return readFile.apply(this, arguments)

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
        let filesystem
        try {
          filesystem = asar.disk.readFilesystemSync(asarPath)
        } catch (err) {
          return callback(createError(AsarError.INVALID_ARCHIVE, { asarPath }))
        }

        let stats
        try {
          stats = filesystem.getFileEx(filePath)
        } catch (_error) {
          callback(createError(AsarError.NOT_FOUND, { asarPath, filePath }))
          return
        }

        if (stats.size === 0) {
          const content = Buffer.alloc(0)
          callback(null, options.encoding ? content.toString(options.encoding) : content)
          return
        }

        if (stats.unpacked) {
          return readFile.apply(this, [path.join(asarPath + '.unpacked', filePath), options, callback])
        }

        const headerSize = filesystem.headerSize
        const fd = openSync(asarPath, 'r')

        const result = Buffer.alloc(stats.size)
        oldRead.apply(this, [fd, result, 0, stats.size, 8 + headerSize + parseInt(stats.offset, 10), (err) => {
          closeSync(fd)
          if (err) return callback(err)
          callback(null, result)
        }])
      })
    }
  })

  const _readFilePromise = util.promisify(fs.readFile)
  overwrite('promises.readFile', (readFilePromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return readFilePromise.apply(this, arguments)
      return _readFilePromise(p, options)
    }
  })

  overwrite('statSync', (statSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar) return statSync.apply(this, arguments)
      try {
        return asarStatsToFsStats(asar.statFile(asarPath, filePath, true), options && options.bigint)
      } catch (err) {
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
      }
    }
  })

  overwrite('lstatSync', (lstatSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar) return lstatSync.apply(this, arguments)
      try {
        return asarStatsToFsStats(asar.statFile(asarPath, filePath, false), options && options.bigint)
      } catch (err) {
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
      }
    }
  })

  overwrite('lstat', (lstat) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar) return lstat.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      process.nextTick(() => {
        let stat
        try {
          stat = asarStatsToFsStats(asar.statFile(asarPath, filePath, false), options && options.bigint)
        } catch (err) {
          callback(createError(AsarError.NOT_FOUND, { asarPath, filePath }))
          return
        }
        callback(null, stat)
      })
    }
  })

  const _lstatPromise = util.promisify(fs.lstat)
  overwrite('promises.lstat', (lstatPromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar } = splitPath(path.resolve(p))
      if (!isAsar) return lstatPromise.apply(this, arguments)
      return _lstatPromise(p, options)
    }
  })

  overwrite('readdirSync', (readdirSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar) return readdirSync.apply(this, arguments)
      let node
      try {
        node = asar.statFile(asarPath, filePath, true)
      } catch (_) {
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
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
      throw createError(AsarError.NOT_DIR)
    }
  })

  overwrite('readdir', (readdir) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar) return readdir.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      process.nextTick(() => {
        let node
        try {
          node = asar.statFile(asarPath, filePath, true)
        } catch (_) {
          callback(createError(AsarError.NOT_FOUND, { asarPath, filePath }))
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
        callback(createError(AsarError.NOT_DIR))
      })
    }
  })

  const _readdirPromise = util.promisify(fs.readdir)
  overwrite('promises.readdir', (readdirPromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar } = splitPath(path.resolve(p))
      if (!isAsar) return readdirPromise.apply(this, arguments)
      return _readdirPromise(p, options)
    }
  })

  overwrite('existsSync', (existsSync) => {
    return function (p) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return existsSync.apply(this, arguments)
      try {
        asar.statFile(asarPath, filePath)
        return true
      } catch (_error) {
        return false
      }
    }
  })

  overwrite('exists', (oldExists) => {
    function exists (p, callback) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return oldExists.apply(this, arguments)
      assertCallback(callback)
      try {
        asar.statFile(asarPath, filePath)
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
    function _realpathSync (p, asarPath, filePath, options) {
      if (!options) {
        options = { encoding: 'utf8' }
      } else if (typeof options === 'string') {
        options = { encoding: options }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }
      let stat
      try {
        stat = asar.statFile(asarPath, filePath, false)
      } catch (err) {
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
      }
      if (stat.link) filePath = stat.link
      const result = path.join(oldRealpathSync(asarPath), filePath)
      if (options.encoding === 'utf8') {
        return result
      }
      if (options.encoding === 'buffer') {
        return Buffer.from(result)
      }
      return Buffer.from(result).toString(options.encoding)
    }

    function realpathSync (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return oldRealpathSync.apply(this, arguments)
      return _realpathSync(p, asarPath, filePath, options)
    }
    realpathSync.native = function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return oldRealpathSync.native.apply(this, arguments)
      return _realpathSync(p, asarPath, filePath, options)
    }
    return realpathSync
  })

  overwrite('realpath', (oldRealpath) => {
    const _realpath = function (p, asarPath, filePath, options, callback) {
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
          stat = asar.statFile(asarPath, filePath, false)
        } catch (err) {
          callback(createError(AsarError.NOT_FOUND, { asarPath, filePath }))
          return
        }
        if (stat.link) filePath = stat.link
        oldRealpath(asarPath, (err, real) => {
          if (err) {
            callback(err)
            return
          }
          const result = path.join(real, filePath)
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
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return oldRealpath.apply(this, arguments)
      return _realpath(p, asarPath, filePath, options, callback)
    }

    realpath.native = function (p, options, callback) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return oldRealpath.native.apply(this, arguments)
      return _realpath(p, asarPath, filePath, options, callback)
    }

    return realpath
  })

  const _realpathPromise = util.promisify(fs.realpath)
  overwrite('promises.realpath', (realpathPromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar } = splitPath(path.resolve(p))
      if (!isAsar) return realpathPromise.apply(this, arguments)
      return _realpathPromise(p, options)
    }
  })

  overwrite('mkdirSync', (mkdirSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return mkdirSync.apply(this, arguments)
      throw createError(AsarError.NOT_DIR)
    }
  })

  overwrite('mkdir', (mkdir) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const { isAsar, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return mkdir.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)
      process.nextTick(() => {
        callback(createError(AsarError.NOT_DIR))
      })
    }
  })

  const _mkdirPromise = util.promisify(fs.mkdir)
  overwrite('promises.mkdir', (mkdirPromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return mkdirPromise.apply(this, arguments)
      return _mkdirPromise(p, options)
    }
  })

  overwrite('copyFileSync', (copyFileSync) => {
    return function (src, dest, mode) {
      src = bufferToString(src)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(src))
      if (!isAsar || filePath === '') return copyFileSync.apply(this, arguments)

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
        stats = asar.statFile(asarPath, filePath)
      } catch (err) {
        closeSync(fd)
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
      }

      if (stats.unpacked) {
        closeSync(fd)
        return copyFileSync.call(this, path.join(asarPath + '.unpacked', filePath), dest, mode)
      }

      dest = bufferToString(dest)
      const wfd = openSync(dest, 'w')

      try {
        readFileChunk(
          fd,
          8 + headerSize + parseInt(stats.offset, 10),
          8 + headerSize + parseInt(stats.offset, 10) + stats.size,
          (chunk, curpos) => {
            fs.writeSync(wfd, chunk, 0, chunk.length)
          }
        )
      } finally {
        closeSync(fd)
        closeSync(wfd)
      }
    }
  })

  overwrite('copyFile', (copyFile) => {
    return function (src, dest, mode, callback) {
      src = bufferToString(src)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(src))
      if (!isAsar || filePath === '') return copyFile.apply(this, arguments)

      if (typeof mode === 'function') {
        callback = mode
        mode = 0
      }
      assertCallback(callback)

      process.nextTick(() => {
        /** @type {NodeJS.ReadStream} */
        let rs
        try {
          rs = originalCreateReadStream(path.resolve(src))
        } catch (err) {
          callback(createError(AsarError.NOT_FOUND, { asarPath, filePath }))
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
      src = bufferToString(src)
      const { isAsar, filePath } = splitPath(path.resolve(src))
      if (!isAsar || filePath === '') return copyFilePromise.apply(this, arguments)
      return _copyFilePromise(src, dest, mode)
    }
  })

  overwrite('accessSync', (accessSync) => {
    return function (p, mode) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return accessSync.apply(this, arguments)

      mode = mode || constants.F_OK

      let stats
      try {
        stats = asar.statFile(asarPath, filePath, true)
      } catch (err) {
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
      }

      if (stats.unpacked) {
        return accessSync.apply(this, [path.join(asarPath + '.unpacked', filePath), mode])
      }

      if (mode & constants.W_OK) {
        throw createError(AsarError.NO_ACCESS, { asarPath, filePath })
      }
    }
  })

  overwrite('access', (access) => {
    return function (p, mode, callback) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return access.apply(this, arguments)

      if (typeof mode === 'function') {
        callback = mode
        mode = constants.F_OK
      }
      assertCallback(callback)

      mode = mode || constants.F_OK

      process.nextTick(() => {
        let stats
        try {
          stats = asar.statFile(asarPath, filePath, true)
        } catch (err) {
          return callback(createError(AsarError.NOT_FOUND, { asarPath, filePath }))
        }

        if (stats.unpacked) {
          return access.apply(this, [path.join(asarPath + '.unpacked', filePath), mode, callback])
        }

        if (mode & constants.W_OK) {
          return callback(createError(AsarError.NO_ACCESS, { asarPath, filePath }))
        }

        callback(null)
      })
    }
  })

  const _accessPromise = util.promisify(fs.access)
  overwrite('promises.access', (accessPromise) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return accessPromise.apply(this, arguments)
      return _accessPromise(p, options)
    }
  })

  overwrite('openSync', (openSync) => {
    return function (p, flags, mode) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return openSync.apply(this, arguments)

      let filesystem
      try {
        filesystem = asar.disk.readFilesystemSync(asarPath)
      } catch (err) {
        throw createError(AsarError.INVALID_ARCHIVE, { asarPath })
      }

      const newPath = copyFileOut(filesystem, filePath)

      return openSync.apply(this, [newPath, flags, mode])
    }
  })

  overwrite('open', (open) => {
    return function (p, flags, mode, callback) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return open.apply(this, arguments)

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
        let filesystem
        try {
          filesystem = asar.disk.readFilesystemSync(asarPath)
        } catch (err) {
          return callback(createError(AsarError.INVALID_ARCHIVE, { asarPath }))
        }

        let newPath
        try {
          newPath = copyFileOut(filesystem, filePath)
        } catch (err) {
          return callback(err)
        }

        return open.apply(this, [newPath, flags, mode, callback])
      })
    }
  })

  overwrite('promises.open', (openPromise) => {
    return function (p, flags, mode) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return openPromise.apply(this, arguments)
      return new Promise((resolve, reject) => {
        let filesystem
        try {
          filesystem = asar.disk.readFilesystemSync(asarPath)
        } catch (err) {
          return reject(createError(AsarError.INVALID_ARCHIVE, { asarPath }))
        }

        let newPath
        try {
          newPath = copyFileOut(filesystem, filePath)
        } catch (err) {
          return reject(err)
        }

        resolve(openPromise(newPath, flags, mode))
      })
    }
  })

  registered = true
  return fs
}

module.exports = {
  overwriteFs,
  cancel
}
