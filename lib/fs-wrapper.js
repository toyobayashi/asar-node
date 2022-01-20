const fs = require('./fs/index.js')
const { internalModuleReadJSON } = require('./module.js')
const { getOrCreateArchive } = require('./archive.js')
const path = require('path')
const util = require('util')
const { splitPath, assertCallback, AsarError, createError, readFileChunk } = require('./util/index.js')

const originalCreateReadStream = fs.createReadStream
const originalCreateWriteStream = fs.createWriteStream
const openSync = fs.openSync
const closeSync = fs.closeSync
const oldReadFile = fs.readFile
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

/**
 * @template P
 * @template {(...args: [...P]) => any} T
 * @param {T} functionToCall
 * @param  {[...P]} args
 * @returns {void}
 */
function nextTick (functionToCall, args = []) {
  process.nextTick(() => functionToCall(...args))
}

function encodeRealpathResult (result, options) {
  if (!options || !options.encoding || options.encoding === 'utf8') {
    return result
  }
  const asBuffer = Buffer.from(result)
  if (options.encoding === 'buffer') {
    return asBuffer
  }
  return asBuffer.toString(options.encoding)
}

let nextInode = 0
const uid = process.getuid != null ? process.getuid() : 0
const gid = process.getgid != null ? process.getgid() : 0
const fakeTime = new Date()
const asarStatsToFsStats = (stats, returnBigInt) => {
  let mode = constants.S_IROTH ^ constants.S_IRGRP ^ constants.S_IRUSR ^ constants.S_IWUSR

  const isDirectory = stats.isDirectory
  const isSymbolicLink = stats.isLink
  const isFile = stats.isFile

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
  if (stats.isDirectory) {
    return constants.UV_DIRENT_DIR || 2
  }
  if (stats.isLink) {
    return constants.UV_DIRENT_LINK || 3
  }
  return constants.UV_DIRENT_FILE || 1
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

function overwriteFs () {
  if (registered) return fs

  oldInternalModuleReadJSON = fsBinding.internalModuleReadJSON
  fsBinding.internalModuleReadJSON = function (p) {
    const { isAsar, filePath } = splitPath(path.resolve(p))
    if (!isAsar || filePath === '') return oldInternalModuleReadJSON.apply(this, arguments)
    return internalModuleReadJSON(p)
  }

  overwrite('readFileSync', (readFileSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return readFileSync.apply(this, arguments)

      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      const info = archive.getFileInfo(filePath)
      if (!info) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

      if (!options) {
        options = { encoding: null, flag: 'r' }
      } else if (typeof options === 'string') {
        options = { encoding: options, flag: 'r' }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }

      if (info.size === 0) return (options.encoding) ? '' : Buffer.alloc(0)
      if (info.unpacked) {
        const realPath = archive.getUnpackedPath(filePath)
        return readFileSync.apply(this, [realPath, options])
      }

      const { encoding } = options
      const buffer = Buffer.alloc(info.size)
      try {
        return archive.withOpen((fd) => {
          fs.readSync(fd, buffer, 0, info.size, info.offset)
          return (encoding) ? buffer.toString(encoding) : buffer
        })
      } catch (_) {
        throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
      }
    }
  })

  overwrite('readFile', (readFile) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar, asarPath, filePath } = pathInfo
      if (!isAsar || filePath === '') return readFile.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      const archive = getOrCreateArchive(asarPath)
      if (!archive) return nextTick(callback, [createError(AsarError.INVALID_ARCHIVE, { asarPath })])

      const info = archive.getFileInfo(filePath)
      if (!info) return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])

      if (!options) {
        options = { encoding: null, flag: 'r' }
      } else if (typeof options === 'string') {
        options = { encoding: options, flag: 'r' }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }

      if (info.size === 0) return nextTick(callback, [null, (options.encoding) ? '' : Buffer.alloc(0)])
      if (info.unpacked) {
        const realPath = archive.getUnpackedPath(filePath)
        return oldReadFile.apply(this, [realPath, options])
      }

      const { encoding } = options
      const buffer = Buffer.alloc(info.size)
      try {
        archive.withOpen((fd) => {
          fs.readSync(fd, buffer, 0, info.size, info.offset)
          nextTick(callback, [null, (encoding) ? buffer.toString(encoding) : buffer])
        })
      } catch (_) {
        return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])
      }
    }
  })

  overwrite('promises.readFile', () => util.promisify(fs.readFile))

  overwrite('statSync', (statSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar, asarPath, filePath } = pathInfo
      if (!isAsar) return statSync.apply(this, arguments)

      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      const stats = archive.stat(filePath, true)
      if (!stats) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

      return asarStatsToFsStats(stats, options && options.bigint)
    }
  })

  overwrite('stat', (stat) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar } = pathInfo
      if (!isAsar) return stat.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      const { asarPath, filePath } = pathInfo

      const archive = getOrCreateArchive(asarPath)
      if (!archive) return nextTick(callback, [createError(AsarError.INVALID_ARCHIVE, { asarPath })])

      const stats = archive.stat(filePath, true)
      if (!stats) return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])

      nextTick(callback, [null, asarStatsToFsStats(stats, options && options.bigint)])
    }
  })

  overwrite('promises.stat', () => util.promisify(fs.stat))

  overwrite('lstatSync', (lstatSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))

      if (!isAsar) return lstatSync.apply(this, arguments)
      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      const stats = archive.stat(filePath, false)
      if (!stats) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

      return asarStatsToFsStats(stats, options && options.bigint)
    }
  })

  overwrite('lstat', (lstat) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar } = pathInfo
      if (!isAsar) return lstat.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      const { asarPath, filePath } = pathInfo

      const archive = getOrCreateArchive(asarPath)
      if (!archive) return nextTick(callback, [createError(AsarError.INVALID_ARCHIVE, { asarPath })])

      const stats = archive.stat(filePath, false)
      if (!stats) return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])

      nextTick(callback, [null, asarStatsToFsStats(stats, options && options.bigint)])
    }
  })

  overwrite('promises.lstat', () => util.promisify(fs.lstat))

  overwrite('readdirSync', (readdirSync) => {
    return function (p, options) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar) return readdirSync.apply(this, arguments)

      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      if (options && options.withFileTypes) {
        const node = archive.getNodeFromPath(filePath, true)
        if (!node) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
        if (node.files == null || typeof node.files !== 'object') {
          throw createError(AsarError.NOT_DIR)
        }
        const items = Object.keys(node.files)
        const dirents = []
        for (let i = 0; i < items.length; ++i) {
          const name = items[i]
          const stats = archive.statNode(node.files[name])
          if (!stats) {
            throw createError(AsarError.NOT_FOUND, { asarPath, filePath: path.join(filePath, name) })
          }
          dirents.push(new fs.Dirent(name, asarStatsToUvFileType(stats)))
        }
        return dirents
      } else {
        const files = archive.readdir(filePath)
        if (files === false) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })
        if (files === 0) throw createError(AsarError.NOT_DIR)
        return files
      }
    }
  })

  overwrite('readdir', (readdir) => {
    return function (p, options, callback) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar } = pathInfo
      if (!isAsar) return readdir.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      const { asarPath, filePath } = pathInfo

      const archive = getOrCreateArchive(asarPath)
      if (!archive) return nextTick(callback, [createError(AsarError.INVALID_ARCHIVE, { asarPath })])

      if (options && options.withFileTypes) {
        const node = archive.getNodeFromPath(filePath, true)
        if (!node) return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])
        if (node.files == null || typeof node.files !== 'object') {
          return nextTick(callback, [createError(AsarError.NOT_DIR)])
        }
        const items = Object.keys(node.files)
        const dirents = []
        for (let i = 0; i < items.length; ++i) {
          const name = items[i]
          const stats = archive.statNode(node.files[name])
          if (!stats) {
            return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath: path.join(filePath, name) })])
          }
          dirents.push(new fs.Dirent(name, asarStatsToUvFileType(stats)))
        }
        nextTick(callback, [null, dirents])
      } else {
        const files = archive.readdir(filePath)
        if (files === false) return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])
        if (files === 0) return nextTick(callback, [createError(AsarError.NOT_DIR)])
        nextTick(callback, [null, files])
      }
    }
  })

  overwrite('promises.readdir', () => util.promisify(fs.readdir))

  overwrite('existsSync', (existsSync) => {
    return function (p) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar, asarPath, filePath } = pathInfo
      if (!isAsar) return existsSync.apply(this, arguments)

      const archive = getOrCreateArchive(asarPath)
      if (!archive) return false
      return archive.stat(filePath, true) !== false
    }
  })

  overwrite('exists', (oldExists) => {
    function exists (p, callback) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar, asarPath, filePath } = pathInfo
      if (!isAsar) return oldExists.apply(this, arguments)
      assertCallback(callback)
      const archive = getOrCreateArchive(asarPath)
      if (!archive) return nextTick(callback, [false])
      nextTick(callback, [archive.stat(filePath, true) !== false])
    }
    Object.defineProperty(exists, util.promisify.custom, {
      configurable: true,
      value: function (p) {
        p = bufferToString(p)
        const pathInfo = splitPath(path.resolve(p))
        const { isAsar, asarPath, filePath } = pathInfo
        if (!isAsar) return oldExists[util.promisify.custom](p)
        const archive = getOrCreateArchive(asarPath)
        if (!archive) return Promise.resolve(false)
        return Promise.resolve(archive.stat(filePath, true) !== false)
      }
    })
    return exists
  })

  function wrapRealpathSync (realpathSync) {
    return function (p, options) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      if (!pathInfo.isAsar) return realpathSync.apply(this, arguments)
      const { asarPath, filePath } = pathInfo

      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      const fileRealPath = archive.realpath(filePath)
      if (fileRealPath === false) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

      if (!options) {
        options = { encoding: 'utf8' }
      } else if (typeof options === 'string') {
        options = { encoding: options }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }

      const result = path.join(realpathSync(asarPath), fileRealPath)
      return encodeRealpathResult(result, options)
    }
  }

  overwrite('realpathSync', (oldRealpathSync) => {
    const realpathSync = wrapRealpathSync(oldRealpathSync)
    realpathSync.native = wrapRealpathSync(oldRealpathSync.native)
    return realpathSync
  })

  function wrapRealpath (realpath) {
    return function (p, options, callback) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      if (!pathInfo.isAsar) return realpath.apply(this, arguments)

      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      assertCallback(callback)

      const { asarPath, filePath } = pathInfo

      const archive = getOrCreateArchive(asarPath)
      if (!archive) return nextTick(callback, [createError(AsarError.INVALID_ARCHIVE, { asarPath })])

      const fileRealPath = archive.realpath(filePath)
      if (fileRealPath === false) return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])

      if (!options) {
        options = { encoding: 'utf8' }
      } else if (typeof options === 'string') {
        options = { encoding: options }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }

      realpath(asarPath, (err, archiveRealPath) => {
        if (!err) {
          const fullPath = path.join(archiveRealPath, fileRealPath)
          callback(null, encodeRealpathResult(fullPath, options))
        } else {
          callback(err)
        }
      })
    }
  }

  overwrite('realpath', (oldRealpath) => {
    const realpath = wrapRealpath(oldRealpath)
    realpath.native = wrapRealpath(oldRealpath.native)
    return realpath
  })

  overwrite('promises.realpath', () => util.promisify(fs.realpath))

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
      nextTick(callback, [createError(AsarError.NOT_DIR)])
    }
  })

  overwrite('promises.mkdir', () => util.promisify(fs.mkdir))

  overwrite('copyFileSync', (copyFileSync) => {
    return function (src, dest, mode) {
      src = bufferToString(src)
      const pathInfo = splitPath(path.resolve(src))
      const { isAsar, asarPath, filePath } = pathInfo
      if (!isAsar || filePath === '') return copyFileSync.apply(this, arguments)

      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      const info = archive.getFileInfo(filePath)
      if (!info) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

      if (info.unpacked) {
        return copyFileSync.call(this, archive.getUnpackedPath(filePath), dest, mode)
      }

      const fd = openSync(asarPath, 'r')
      dest = bufferToString(dest)
      const wfd = openSync(dest, 'w')

      try {
        readFileChunk(
          fd,
          info.offset,
          info.offset + info.size,
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
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar } = pathInfo
      if (!isAsar) return accessSync.apply(this, arguments)

      const { asarPath, filePath } = pathInfo

      if (mode == null) mode = constants.F_OK

      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      const info = archive.getFileInfo(filePath)
      if (!info) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

      if (info.unpacked) {
        const realPath = archive.getUnpackedPath(filePath)
        return accessSync(realPath, mode)
      }

      const stats = archive.stat(filePath, true)
      if (!stats) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

      if (mode & fs.constants.W_OK) throw createError(AsarError.NO_ACCESS, { asarPath, filePath })
    }
  })

  overwrite('access', (access) => {
    return function (p, mode, callback) {
      p = bufferToString(p)
      const pathInfo = splitPath(path.resolve(p))
      const { isAsar } = pathInfo
      if (!isAsar) return access.apply(this, arguments)

      const { asarPath, filePath } = pathInfo

      if (typeof mode === 'function') {
        callback = mode
        mode = fs.constants.F_OK
      }

      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        const error = createError(AsarError.INVALID_ARCHIVE, { asarPath })
        nextTick(callback, [error])
        return
      }

      const info = archive.getFileInfo(filePath)
      if (!info) {
        const error = createError(AsarError.NOT_FOUND, { asarPath, filePath })
        nextTick(callback, [error])
        return
      }

      if (info.unpacked) {
        const realPath = archive.copyFileOut(filePath)
        return fs.access(realPath, mode, callback)
      }

      const stats = archive.stat(filePath, true)
      if (!stats) {
        const error = createError(AsarError.NOT_FOUND, { asarPath, filePath })
        nextTick(callback, [error])
        return
      }

      if (mode & fs.constants.W_OK) {
        const error = createError(AsarError.NO_ACCESS, { asarPath, filePath })
        nextTick(callback, [error])
        return
      }

      nextTick(callback, [null])
    }
  })

  overwrite('promises.access', () => util.promisify(fs.access))

  overwrite('openSync', (openSync) => {
    return function (p, flags, mode) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return openSync.apply(this, arguments)

      const archive = getOrCreateArchive(asarPath)
      if (!archive) throw createError(AsarError.INVALID_ARCHIVE, { asarPath })

      const newPath = archive.copyFileOut(filePath)
      if (!newPath) throw createError(AsarError.NOT_FOUND, { asarPath, filePath })

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

      const archive = getOrCreateArchive(asarPath)
      if (!archive) return nextTick(callback, [createError(AsarError.INVALID_ARCHIVE, { asarPath })])

      const newPath = archive.copyFileOut(filePath)
      if (!newPath) return nextTick(callback, [createError(AsarError.NOT_FOUND, { asarPath, filePath })])

      open.apply(this, [newPath, flags, mode, callback])
    }
  })

  overwrite('promises.open', (openPromise) => {
    return function (p, flags, mode) {
      p = bufferToString(p)
      const { isAsar, asarPath, filePath } = splitPath(path.resolve(p))
      if (!isAsar || filePath === '') return openPromise.apply(this, arguments)
      return new Promise((resolve, reject) => {
        const archive = getOrCreateArchive(asarPath)
        if (!archive) return reject(createError(AsarError.INVALID_ARCHIVE, { asarPath }))

        const newPath = archive.copyFileOut(filePath)
        if (!newPath) return reject(createError(AsarError.NOT_FOUND, { asarPath, filePath }))

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
