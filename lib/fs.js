const nodeRequire = require('./require.js')()
const fs = process.versions.electron ? nodeRequire('original-fs') : require('fs')
const asar = require('./asar.js')
const asarDisk = asar.disk
const path = require('path')
const util = require('util')
const pickle = require('./pickle')
const { splitPath } = require('./util.js')

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

let readFileSync
let readFile
let readFilePromise
let createReadStream
let statSync
let lstatSync
let readdirSync
let existsSync
let realpathSync

function cancel () {
  if (!registered) return

  fs.readFileSync = readFileSync
  fs.readFile = readFile
  fs.promises.readFile = readFilePromise
  fs.createReadStream = createReadStream
  fs.statSync = statSync
  fs.lstatSync = lstatSync
  fs.readdirSync = readdirSync
  fs.existsSync = existsSync
  fs.realpathSync = realpathSync

  readFileSync = undefined
  readFile = undefined
  readFilePromise = undefined
  createReadStream = undefined
  statSync = undefined
  lstatSync = undefined
  readdirSync = undefined
  existsSync = undefined
  realpathSync = undefined

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

function overwriteFs () {
  if (registered) return fs
  readFileSync = fs.readFileSync
  fs.readFileSync = function (p, options) {
    const [isAsar, asarPath, filePath] = splitPath(p)
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

  readFile = fs.readFile
  fs.readFile = function (p, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    const [isAsar, asarPath, filePath] = splitPath(p)
    if (!isAsar || filePath === '') return readFile.apply(this, arguments)

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
        rs = fs.createReadStream(p)
      } catch (err) {
        callback && callback(err)
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

  const _readFilePromise = util.promisify(fs.readFile)

  readFilePromise = fs.promises.readFile
  fs.promises.readFile = function (p, options) {
    const arr = splitPath(p)
    if (!arr[0] || arr[2] === '') return readFilePromise.apply(this, arguments)
    return _readFilePromise(p, options)
  }

  createReadStream = fs.createReadStream
  fs.createReadStream = function (p, options) {
    if (!p || (options && options.fd)) return createReadStream.apply(this, arguments)
    const [isAsar, asarPath, filePath] = splitPath(p)
    if (!isAsar || filePath === '') return createReadStream.apply(this, arguments)

    const fd = fs.openSync(asarPath, 'r')

    const sizeBuf = Buffer.alloc(8)
    if (fs.readSync(fd, sizeBuf, 0, 8, null) !== 8) {
      throw new Error('Unable to read header size')
    }

    const sizePickle = pickle.createFromBuffer(sizeBuf)
    const headerSize = sizePickle.createIterator().readUInt32()

    let stats
    try {
      stats = asar.statFile(asarPath, filePath)
    } catch (_error) {
      throw ENOENT('no such file or directory, open \'' + p + '\'')
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

    return createReadStream('', options)
  }

  statSync = fs.statSync
  fs.statSync = function (p) {
    const [isAsar, asarPath, filePath] = splitPath(p)
    if (!isAsar || filePath === '') return statSync.apply(this, arguments)
    return asarStatsToFsStats(asar.statFile(asarPath, filePath, true))
  }

  lstatSync = fs.lstatSync
  fs.lstatSync = function (p) {
    const [isAsar, asarPath, filePath] = splitPath(p)
    if (!isAsar || filePath === '') return lstatSync.apply(this, arguments)
    return asarStatsToFsStats(asar.statFile(asarPath, filePath))
  }

  readdirSync = fs.readdirSync
  fs.readdirSync = function (p) {
    const [isAsar, asarPath, filePath] = splitPath(p)
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

  existsSync = fs.existsSync
  fs.existsSync = function (p) {
    if (Buffer.isBuffer(p)) p = p.toString()
    const [isAsar, asarPath, filePath] = splitPath(p)
    if (!isAsar || filePath === '') return existsSync.apply(this, arguments)
    try {
      asar.statFile(asarPath, filePath)
      return true
    } catch (_error) {
      return false
    }
  }

  realpathSync = fs.realpathSync
  fs.realpathSync = function (p) {
    let [isAsar, asarPath, filePath] = splitPath(p)
    if (!isAsar || filePath === '') return realpathSync.apply(this, arguments)
    const stat = asar.statFile(asarPath, filePath)
    if (stat.link) filePath = stat.link
    return path.join(realpathSync(asarPath), filePath)
  }

  registered = true
  return fs
}

module.exports = {
  overwriteFs,
  cancel
}
