const path = require('path')
const toNamespacedPath = path.toNamespacedPath
const fs = require('./fs/index.js')
const { tryRedirectUnpacked } = require('./util/index.js')

let options = null

function getOptionValue (optionName) {
  // const options = getOptionsFromBinding()
  if (!options) {
    options = new Map()
    for (let i = 0; i < process.argv.length; ++i) {
      const arg = process.argv[i]
      if (arg.startsWith('--')) {
        if (arg.startsWith('--no-')) {
          options.set('--' + arg.slice(5), { value: false })
        } else {
          const kv = arg.split('=')
          options.set(kv[0], { value: kv[1] === undefined ? true : kv[1] })
        }
      }
    }
  }
  if (optionName.startsWith('--no-')) {
    const option = options.get('--' + optionName.slice(5))
    return option && !option.value
  }
  const v = options.get(optionName)
  return v != null ? v.value : undefined
}

const preserveSymlinks = getOptionValue('--preserve-symlinks')
const preserveSymlinksMain = getOptionValue('--preserve-symlinks-main')

const CHAR_FORWARD_SLASH = 47
const ArrayPrototypeJoin = (...args) => Array.prototype.join.call(...args)
const StringPrototypeCharCodeAt = (...args) => String.prototype.charCodeAt.call(...args)
const RegExpPrototypeTest = (...args) => RegExp.prototype.test.call(...args)
const ObjectKeys = (...args) => Object.keys(...args)
const JSONParse = (...args) => JSON.parse(...args)

const packageJsonCache = new Map()

function toRealPath (requestPath) {
  return fs.realpathSync(requestPath)
}

function redirectUnpackedPath (filename) {
  if (filename.endsWith('.node') || filename.endsWith('.asar')) {
    filename = tryRedirectUnpacked(filename)
  }
  return filename
}

function tryFile (requestPath, isMain) {
  const rc = stat(requestPath)
  if (rc !== 0) return
  if (preserveSymlinks && !isMain) {
    return path.resolve(requestPath)
  }
  return toRealPath(requestPath)
}

function tryExtensions (p, exts, isMain) {
  for (let i = 0; i < exts.length; i++) {
    const filename = tryFile(p + exts[i], isMain)

    if (filename) {
      return filename
    }
  }
  return false
}

function tryPackage (requestPath, exts, isMain, originalPath) {
  const tmp = readPackage(requestPath)
  const pkg = tmp != null ? tmp.main : undefined

  if (!pkg) {
    return tryExtensions(path.resolve(requestPath, 'index'), exts, isMain)
  }

  const filename = path.resolve(requestPath, pkg)
  let actual = tryFile(filename, isMain) ||
    tryExtensions(filename, exts, isMain) ||
    tryExtensions(path.resolve(filename, 'index'), exts, isMain)
  if (actual === false) {
    actual = tryExtensions(path.resolve(requestPath, 'index'), exts, isMain)
    if (!actual) {
      const err = new Error(
        `Cannot find module '${filename}'. ` +
        'Please verify that the package.json has a valid "main" entry'
      )
      err.code = 'MODULE_NOT_FOUND'
      err.path = path.resolve(requestPath, 'package.json')
      err.requestPath = originalPath
      throw err
    } else {
      const jsonPath = path.resolve(requestPath, 'package.json')
      process.emitWarning(
        `Invalid 'main' field in '${jsonPath}' of '${pkg}'. ` +
          'Please either fix that or report it to the module author',
        'DeprecationWarning',
        'DEP0128'
      )
    }
  }
  return actual
}

function internalModuleReadJSON (filename) {
  if (!fs.existsSync(filename)) return []
  let str
  try {
    str = fs.readFileSync(filename, 'utf8')
  } catch (_) {
    return []
  }
  return [str, str.length > 0]
}

const cache = new Map()
const packageJsonReader = {
  read (jsonPath) {
    if (cache.has(jsonPath)) {
      return cache.get(jsonPath)
    }

    const { 0: string, 1: containsKeys } = internalModuleReadJSON(
      toNamespacedPath(jsonPath)
    )
    const result = { string, containsKeys }
    cache.set(jsonPath, result)
    return result
  }
}

function readPackage (requestPath) {
  const jsonPath = path.resolve(requestPath, 'package.json')

  const existing = packageJsonCache.get(jsonPath)
  if (existing !== undefined) return existing

  const result = packageJsonReader.read(jsonPath)
  const json = result.containsKeys === false ? '{}' : result.string
  if (json === undefined) {
    packageJsonCache.set(jsonPath, false)
    return false
  }

  try {
    const parsed = JSONParse(json)
    const filtered = {
      name: parsed.name,
      main: parsed.main,
      exports: parsed.exports,
      imports: parsed.imports,
      type: parsed.type
    }
    packageJsonCache.set(jsonPath, filtered)
    return filtered
  } catch (e) {
    e.path = jsonPath
    e.message = 'Error parsing ' + jsonPath + ': ' + e.message
    throw e
  }
}

function internalModuleStat (filename) {
  try {
    return fs.statSync(filename).isDirectory() ? 1 : 0
  } catch (_) {
    return -1
  }
}

const statCache = null

function stat (filename) {
  filename = path.toNamespacedPath(filename)
  if (statCache !== null) {
    const result = statCache.get(filename)
    if (result !== undefined) return result
  }
  const result = internalModuleStat(filename)
  if (statCache !== null && result >= 0) {
    // Only set cache when `internalModuleStat(filename)` succeeds.
    statCache.set(filename, result)
  }
  return result
}

const trailingSlashRegex = /(?:^|\/)\.?\.$/
function _findPath (request, paths, isMain) {
  const Module = this
  const absoluteRequest = path.isAbsolute(request)
  if (absoluteRequest) {
    paths = ['']
  } else if (!paths || paths.length === 0) {
    return false
  }

  const cacheKey = request + '\x00' + ArrayPrototypeJoin(paths, '\x00')
  const entry = Module._pathCache[cacheKey]
  if (entry) { return entry }

  let exts
  let trailingSlash = request.length > 0 &&
    StringPrototypeCharCodeAt(request, request.length - 1) ===
    CHAR_FORWARD_SLASH
  if (!trailingSlash) {
    trailingSlash = RegExpPrototypeTest(trailingSlashRegex, request)
  }

  // For each path
  for (let i = 0; i < paths.length; i++) {
    // Don't search further if path doesn't exist
    const curPath = paths[i]
    if (curPath && stat(curPath) < 1 && !curPath.endsWith('.asar')) continue

    // if (!absoluteRequest) {
    //   const exportsResolved = resolveExports(curPath, request)
    //   if (exportsResolved) { return exportsResolved }
    // }

    const basePath = path.resolve(curPath, request)
    let filename

    const rc = stat(basePath)
    if (!trailingSlash) {
      if (rc === 0) { // File.
        if (!isMain) {
          if (preserveSymlinks) {
            filename = path.resolve(basePath)
          } else {
            filename = toRealPath(basePath)
          }
        } else if (preserveSymlinksMain) {
          // For the main module, we use the preserveSymlinksMain flag instead
          // mainly for backward compatibility, as the preserveSymlinks flag
          // historically has not applied to the main module.  Most likely this
          // was intended to keep .bin/ binaries working, as following those
          // symlinks is usually required for the imports in the corresponding
          // files to resolve; that said, in some use cases following symlinks
          // causes bigger problems which is why the preserveSymlinksMain option
          // is needed.
          filename = path.resolve(basePath)
        } else {
          filename = toRealPath(basePath)
        }
      }

      if (!filename) {
        // Try it with each of the extensions
        if (exts === undefined) { exts = ObjectKeys(Module._extensions) }
        filename = tryExtensions(basePath, exts, isMain)
      }
    }

    if (!filename && rc === 1) { // Directory.
      // try it with each of the extensions at "index"
      if (exts === undefined) { exts = ObjectKeys(Module._extensions) }
      filename = tryPackage(basePath, exts, isMain, request)
    }

    while (filename && filename.endsWith('.asar')) {
      if (exts === undefined) { exts = ObjectKeys(Module._extensions) }
      filename = redirectUnpackedPath(filename)
      filename = tryPackage(filename, exts, isMain, request)
    }

    if (filename) {
      filename = redirectUnpackedPath(filename)
      Module._pathCache[cacheKey] = filename
      return filename
    }
  }

  return false
};

exports._findPath = _findPath
exports.tryPackage = tryPackage
exports.redirectUnpackedPath = redirectUnpackedPath
exports.internalModuleReadJSON = internalModuleReadJSON
