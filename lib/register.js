const { overwriteFs, cancel } = require('./fs.js')

let registered = false

let oldResolveLookupPaths
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

  Module._resolveLookupPaths = oldResolveLookupPaths
  oldResolveLookupPaths = undefined
  Module._findPath = oldFindPath
  oldFindPath = undefined
  Module._extensions['.asar'] = oldAsarLoader
  oldAsarLoader = undefined

  cancel()
  registered = false
}

function tryFile (fs, ext, fileWithExt) {
  if (ext === '.node' || ext === '.asar') {
    const unpackedPath = fileWithExt.replace(/\.asar/, '.asar.unpacked')
    if (fs.existsSync(fileWithExt) && fs.statSync(fileWithExt).isFile() && fs.existsSync(unpackedPath) && fs.statSync(unpackedPath).isFile()) {
      return unpackedPath
    }
  } else {
    if (fs.existsSync(fileWithExt) && fs.statSync(fileWithExt).isFile()) {
      return fileWithExt
    }
  }
  return false
}

function tryExtensions (fs, exts, base) {
  for (let i = 0; i < exts.length; i++) {
    const ext = exts[i]
    const fileWithExt = base + ext
    const filepath = tryFile(fs, ext, fileWithExt)
    if (filepath) {
      return { ext, filepath }
    }
  }
  return false
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
  const fs = overwriteFs()

  if (typeof Module._resolveLookupPaths === 'function' && typeof Module._findPath === 'function' && Module._extensions != null) {
    oldResolveLookupPaths = Module._resolveLookupPaths
    Module._resolveLookupPaths = oldResolveLookupPaths.length === 2
      ? function (request, parent) {
        const result = oldResolveLookupPaths.call(this, request, parent)
        if (!result) return result

        result._parent = parent
        return result
      }
      : function (request, parent, newReturn) {
        const result = oldResolveLookupPaths.call(this, request, parent, newReturn)

        result._parent = parent
        return result
      }

    const { splitPath } = require('./util.js')
    oldFindPath = Module._findPath
    Module._findPath = function (request, paths, isMain) {
      const parent = paths ? paths._parent : null
      if (paths) delete paths._parent

      if (!path.isAbsolute(request) && request.charAt(0) !== '.') {
        if (parent && parent.filename && parent.filename.endsWith('.asar')) {
          paths.unshift(path.join(parent.filename, 'node_modules.asar'))
          paths.unshift(path.join(parent.filename, 'node_modules'))
        }

        for (let i = 0; i < paths.length; i++) {
          const target = path.join(paths[i], request)
          try {
            return checkFilename(request, target)
          } catch (_error) {
            continue
          }
        }
        throw new Error('Cannot find module \'' + request + '\'')
      } else {
        const requestFromAsar = !!parent && !!parent.filename && (parent.filename.lastIndexOf('.asar') !== -1)
        if (requestFromAsar) {
          if (path.isAbsolute(request)) return checkFilename(request, request)
          const absoluteRequest = path.resolve(path.extname(parent.filename) === '.asar' ? parent.filename : path.dirname(parent.filename), request)
          return checkFilename(request, absoluteRequest)
        }
      }

      const [isAsar, asarPath, filePath] = splitPath(request)
      if (!isAsar) return oldFindPath.apply(this, arguments)
      const parentDirname = (parent && parent.filename) ? (path.extname(parent.filename) === '.asar' ? parent.filename : path.dirname(parent.filename)) : process.cwd()
      if (filePath === '') {
        return path.resolve(parentDirname, asarPath)
      }

      const absoluteRequest = path.resolve(parentDirname, request)
      return checkFilename(request, absoluteRequest)
    }

    oldAsarLoader = Module._extensions['.asar']
    Module._extensions['.asar'] = function asarCompiler (module, filename) {
      const pkgPath = path.join(filename, 'package.json')
      const exts = Object.keys(Module._extensions)
      if (fs.existsSync(pkgPath) && fs.statSync(pkgPath).isFile()) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        pkg.main = pkg.main || 'index'
        const main = path.join(filename, pkg.main)
        const mainExt = path.extname(main)
        if (mainExt !== '') {
          const compileFilename = tryFile(fs, mainExt, main)
          if (compileFilename) {
            return Module._extensions[mainExt](module, compileFilename)
          }
          throw new Error('Cannot find module \'' + filename + '\'')
        }
        const fileAndExt = tryExtensions(fs, exts, main)
        if (fileAndExt) {
          return Module._extensions[fileAndExt.ext](module, fileAndExt.filepath)
        }
        if (fs.existsSync(main) && fs.statSync(main).isDirectory()) {
          return asarCompiler(module, main)
        }
        throw new Error('Cannot find module \'' + filename + '\'')
      }

      const fileAndExt = tryExtensions(fs, exts, path.join(filename, 'index'))
      if (fileAndExt) {
        return Module._extensions[fileAndExt.ext](module, fileAndExt.filepath)
      }
      if (typeof oldAsarLoader === 'function') {
        return oldAsarLoader.call(Module._extensions, module, filename)
      }
      throw new Error('Cannot find module \'' + filename + '\'')
    }

    registered = true
  }

  function checkFolder (request, absolutePath) {
    const pkgPath = path.join(absolutePath, 'package.json')

    if (fs.existsSync(pkgPath) && fs.statSync(pkgPath).isFile()) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      pkg.main = pkg.main || 'index'
      const main = path.join(absolutePath, pkg.main)
      return checkFilename(request, main)
    }

    const exts = Object.keys(Module._extensions)
    for (let i = 0; i < exts.length; ++i) {
      const ext = exts[i]
      const file = path.join(absolutePath, 'index' + ext)
      if (ext === '.node') {
        const fileUnpacked = file.replace(/\.asar/, '.asar.unpacked')
        if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.existsSync(fileUnpacked) && fs.statSync(fileUnpacked).isFile()) {
          return fileUnpacked
        }
      } else {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          return file
        }
      }
    }
    throw new Error('Cannot find module \'' + request + '\'')
  }

  function checkFilename (request, absolutePath) {
    if (!path.isAbsolute(absolutePath)) throw new Error('Not absolute path.')
    if (fs.existsSync(absolutePath)) {
      if (fs.statSync(absolutePath).isDirectory()) {
        return checkFolder(request, absolutePath)
      }

      const ext = path.extname(absolutePath)
      if (ext === '.node') {
        const unpackedPath = absolutePath.replace(/\.asar/, '.asar.unpacked')
        if (fs.existsSync(unpackedPath) && fs.statSync(unpackedPath).isFile()) {
          return unpackedPath
        }
        throw new Error('Cannot find module \'' + request + '\'')
      }
      return absolutePath
    }

    const exts = Object.keys(Module._extensions)
    for (let i = 0; i < exts.length; ++i) {
      const ext = exts[i]
      const file = absolutePath + ext
      if (ext === '.node') {
        const unpacked = file.replace(/\.asar/, '.asar.unpacked')
        if (fs.existsSync(file) && fs.statSync(file).isFile() &&
            fs.existsSync(unpacked) && fs.statSync(unpacked).isFile()) {
          return unpacked
        }
      } else {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
      }
    }

    throw new Error('Cannot find module \'' + request + '\'')
  }
}

function checkRegisterState () {
  return registered
}

exports.register = register
exports.unregister = unregister
exports.checkRegisterState = checkRegisterState
