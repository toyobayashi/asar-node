const { isAsarDisabled, getModuleConstructor, initTempDir, isElectron } = require('./util.js')
const originalFs = require('./fs/original.js')
const { overwriteChildProcess, cancel: cancelCp } = require('./child-process.js')
const { overwriteFs, cancel: cancelFs } = require('./fs-wrapper.js')
const { tryPackage, redirectUnpackedPath, _findPath } = require('./module.js')

let registered = false

let oldLoad
let oldFindPath
let oldAsarLoader

function unregister () {
  if (!registered) return
  const Module = getModuleConstructor()
  if (!Module) {
    registered = false
    return
  }

  Module._load = oldLoad
  oldLoad = undefined
  Module._findPath = oldFindPath
  oldFindPath = undefined
  Module._extensions['.asar'] = oldAsarLoader
  oldAsarLoader = undefined

  cancelFs()
  cancelCp()
  registered = false
}

function register () {
  if (isElectron || registered) return
  initTempDir()
  const Module = getModuleConstructor()
  if (!Module) return

  const path = require('path')
  overwriteChildProcess()
  overwriteFs()

  if (typeof Module._load === 'function' && typeof Module._findPath === 'function' && Module._extensions != null) {
    oldLoad = Module._load
    Module._load = function (request, parent, isMain) {
      try {
        return oldLoad.apply(this, arguments)
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          if (request === 'original-fs') return originalFs
        }
        throw err
      }
    }

    function resolveAsar (filename, cacheKey, isMain, request) {
      let filenameInAsar = filename
      while (filenameInAsar && filenameInAsar.endsWith('.asar')) {
        filenameInAsar = tryPackage(filename, Object.keys(Module._extensions), isMain, request)
        if (!filenameInAsar) {
          const err = new Error('Cannot find module \'' + request + '\'')
          err.code = 'MODULE_NOT_FOUND'
          throw err
        }
        filenameInAsar = redirectUnpackedPath(filenameInAsar)
        if (cacheKey) Module._pathCache[cacheKey] = filenameInAsar
      }
      return filenameInAsar
    }

    oldFindPath = Module._findPath
    Module._findPath = function (request, paths, isMain) {
      const officialFileResult = oldFindPath.call(this, request, paths, isMain)
      if (isAsarDisabled()) return officialFileResult
      if (officialFileResult) {
        const cacheKey = request + '\x00' + Array.prototype.join.call(paths, '\x00')
        return resolveAsar(officialFileResult, cacheKey, isMain, request)
      }
      return _findPath.call(Module, request, paths, isMain)
    }

    oldAsarLoader = Module._extensions['.asar']
    Module._extensions['.asar'] = function asarCompiler (module, filename) {
      if (isAsarDisabled()) {
        return Module._extensions['.js'](module, filename)
      }
      const filenameInAsar = resolveAsar(filename, null, module === require.main, filename)
      const ext = path.extname(filenameInAsar)
      return Module._extensions[ext](module, filenameInAsar)
    }

    registered = true
  }
}

function checkRegisterState () {
  return registered
}

exports.register = register
exports.unregister = unregister
exports.checkRegisterState = checkRegisterState
