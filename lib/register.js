const { overwriteFs, cancel } = require('./fs.js')

let registered = false

let oldFindPath
let oldAsarLoader

function unregister () {
  if (!registered) return
  let Module
  try {
    Module = require('module')
  } catch (_error) {
    Module = null
  }
  if (!Module) {
    registered = false
    return
  }

  Module._findPath = oldFindPath
  oldFindPath = undefined
  Module._extensions['.asar'] = oldAsarLoader
  oldAsarLoader = undefined

  cancel()
  registered = false
}

function register () {
  if (registered) return
  let Module
  try {
    Module = require('module')
  } catch (_error) {
    Module = null
  }
  if (!Module) return

  const path = require('path')
  overwriteFs()

  if (typeof Module._findPath === 'function' && Module._extensions != null) {
    oldFindPath = Module._findPath
    Module._findPath = function (request, paths, isMain) {
      const officialFileResult = oldFindPath.call(this, request, paths, isMain)
      if (officialFileResult) return officialFileResult
      return require('./module.js')._findPath.call(Module, request, paths, isMain)
    }

    oldAsarLoader = Module._extensions['.asar']
    Module._extensions['.asar'] = function asarCompiler (module, filename) {
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
