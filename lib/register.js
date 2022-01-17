const { isAsarDisabled, getModuleConstructor, initTempDir } = require('./util.js')
const originalFs = require('./original-fs.js')
const { overwriteChildProcess, cancel: cancelCp } = require('./child-process.js')
const { overwriteFs, cancel: cancelFs } = require('./fs.js')

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
  if (registered) return
  initTempDir()
  const Module = getModuleConstructor()
  if (!Module) return

  const path = require('path')
  overwriteChildProcess()
  overwriteFs()

  if (typeof Module._load === 'function' && typeof Module._findPath === 'function' && Module._extensions != null) {
    oldLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === 'original-fs') {
        return originalFs
      }
      return oldLoad.apply(this, arguments)
    }

    oldFindPath = Module._findPath
    Module._findPath = function (request, paths, isMain) {
      const officialFileResult = oldFindPath.call(this, request, paths, isMain)
      if (officialFileResult) return officialFileResult
      if (!isAsarDisabled()) {
        return require('./module.js')._findPath.call(Module, request, paths, isMain)
      }
      return officialFileResult
    }

    oldAsarLoader = Module._extensions['.asar']
    Module._extensions['.asar'] = function asarCompiler (module, filename) {
      if (isAsarDisabled()) {
        return Module._extensions['.js'](module, filename)
      }
      filename = require('./module.js').tryPackage(filename, Object.keys(Module._extensions), module === require.main, filename)
      if (!filename) {
        throw new Error('Cannot find module \'' + filename + '\'')
      }
      filename = require('./module.js').redirectUnpackedPath(filename)
      module.filename = filename
      module.paths = Module._nodeModulePaths(path.dirname(filename))
      const ext = path.extname(filename)
      return Module._extensions[ext](module, filename)
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
