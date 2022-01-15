const childProcess = require('child_process')
const originalFs = require('./original-fs.js')
const { overwriteFs, cancel } = require('./fs.js')

let registered = false

let oldLoad
let oldFindPath
let oldAsarLoader
let oldFork

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

  Module._load = oldLoad
  oldLoad = undefined
  Module._findPath = oldFindPath
  oldFindPath = undefined
  Module._extensions['.asar'] = oldAsarLoader
  oldAsarLoader = undefined
  childProcess.fork = oldFork
  oldFork = undefined

  cancel()
  registered = false
}

function register () {
  if (process.env.ELECTRON_NO_ASAR && process.env.ELECTRON_NO_ASAR !== '0') {
    return
  }
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

  if (typeof Module._load === 'function' && typeof Module._findPath === 'function' && Module._extensions != null) {
    oldFork = childProcess.fork
    childProcess.fork = function (modulePath, args, options) {
      if (process.noAsar) {
        return oldFork.apply(this, arguments)
      }
      return oldFork.call(this, require('path').join(__dirname, 'fork.js'), [
        registered ? '1' : '0',
        require('./lookup.js').checkLookupState() ? '1' : '0',
        path.resolve(modulePath),
        ...(args || [])
      ], options)
    }

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
      if (!process.noAsar) {
        return require('./module.js')._findPath.call(Module, request, paths, isMain)
      }
      return officialFileResult
    }

    oldAsarLoader = Module._extensions['.asar']
    Module._extensions['.asar'] = function asarCompiler (module, filename) {
      if (process.noAsar) {
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
