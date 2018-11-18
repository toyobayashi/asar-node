let Module
try {
  Module = require('module')
} catch (_error) {
  Module = null
}

const path = require('path')
const fs = require('./fs.js')
const { toAbsolute, splitPath, internalModules } = require('./util.js')

function checkFilename (request, absolutePath) {
  if (!path.isAbsolute(absolutePath)) throw new Error('Not absolute path.')
  if (path.extname(absolutePath) !== '') {
    if (path.extname(absolutePath) === '.node') {
      if (fs.existsSync(absolutePath) && fs.existsSync(absolutePath.replace(/\.asar/, '.asar.unpacked'))) {
        return absolutePath.replace(/\.asar/, '.asar.unpacked')
      } else {
        throw new Error('Cannot find module \'' + request + '\'')
      }
    }
    if (fs.existsSync(absolutePath)) return absolutePath
    throw new Error('Cannot find module \'' + request + '\'')
  }
  if (fs.existsSync(absolutePath + '.js')) return absolutePath + '.js'
  if (fs.existsSync(absolutePath + '.json')) return absolutePath + '.json'
  if (fs.existsSync(absolutePath + '.node') && fs.existsSync(absolutePath.replace(/\.asar/, '.asar.unpacked') + '.node')) return absolutePath.replace(/\.asar/, '.asar.unpacked') + '.node'
  throw new Error('Cannot find module \'' + request + '\'')
}

if (Module && Module._resolveLookupPaths) {
  const oldResolveLookupPaths = Module._resolveLookupPaths
  Module._resolveLookupPaths = function (request, parent, newReturn) {
    const result = oldResolveLookupPaths(request, parent, newReturn)

    const paths = newReturn ? result : result[1]
    let length = paths.length
    for (let i = 0; i < length; i++) {
      if (path.basename(paths[i]) === 'node_modules') {
        paths.splice(i + 1, 0, paths[i] + '.asar')
        length = paths.length
      }
    }

    result._parent = parent

    return result
  }
}

if (Module && Module._findPath) {
  const oldFindPath = Module._findPath
  Module._findPath = function (request, paths, isMain) {
    const parent = paths._parent

    if (!(path.isAbsolute(request) || request.charAt(0) === '.')) {
      if (parent && parent.filename) {
        const index = parent.filename.lastIndexOf('.asar')
        if (index !== -1) {
          if (internalModules.includes(request)) return request
          if (paths._parent.filename.substr(-5) === '.asar') {
            paths.unshift(path.join(paths._parent.filename, 'node_modules.asar'))
            paths.unshift(path.join(paths._parent.filename, 'node_modules'))
          }
          for (let i = 0; i < paths.length; i++) {
            const target = path.join(paths[i], request)
            try {
              if (fs.existsSync(target)) {
                if (fs.statSync(target).isDirectory()) {
                  const pkgPath = path.join(target, 'package.json')
                  const indexjs = path.join(target, 'index.js')
                  const indexjson = path.join(target, 'index.json')
                  const indexnode = path.join(target, 'index.node')

                  if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
                    pkg.main = pkg.main || 'index'
                    const main = path.join(target, pkg.main)
                    return checkFilename(request, main)
                  } else if (fs.existsSync(indexjs)) {
                    return indexjs
                  } else if (fs.existsSync(indexjson)) {
                    return indexjson
                  } else if (fs.existsSync(indexnode) && fs.existsSync(indexnode.replace(/\.asar/, '.asar.unpacked'))) {
                    return indexnode.replace(/\.asar/, '.asar.unpacked')
                  }
                } else {
                  return checkFilename(request, target)
                }
              } else {
                return checkFilename(request, target)
              }
            } catch (_error) {
              continue
            }
          }
          throw new Error('Cannot find module \'' + request + '\'')
        }
      }
    } else {
      if (parent && parent.filename) {
        const index = parent.filename.lastIndexOf('.asar')
        if (index !== -1) {
          const absoluteRequest = toAbsolute(path.join(path.extname(parent.filename) === '.asar' ? parent.filename : path.dirname(parent.filename), request))
          return checkFilename(request, absoluteRequest)
        }
      }
    }

    const [isAsar, asarPath, filePath] = splitPath(request)
    if (!isAsar) return oldFindPath.apply(this, arguments)
    if (filePath === '') {
      return toAbsolute(asarPath)
    }

    const absoluteRequest = toAbsolute(request)
    return checkFilename(request, absoluteRequest)
  }
}

if (Module && Module._extensions) {
  Module._extensions['.asar'] = Module._extensions['.asar'] || function (module, filename) {
    const pkgPath = toAbsolute(path.join(filename, 'package.json'))
    const indexjs = toAbsolute(path.join(filename, 'index.js'))
    const indexjson = toAbsolute(path.join(filename, 'index.json'))
    const indexnode = toAbsolute(path.join(filename, 'index.node'))
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      pkg.main = pkg.main || 'index'
      const main = toAbsolute(path.join(filename, pkg.main))
      if (path.extname(main) !== '') {
        if (fs.existsSync(main)) return Module._extensions[path.extname(main)](module, main)
        throw new Error('Cannot find module \'' + filename + '\'')
      }
      if (fs.existsSync(main + '.js')) return Module._extensions['.js'](module, main + '.js')
      if (fs.existsSync(main + '.json')) return Module._extensions['.json'](module, main + '.json')
      if (fs.existsSync(main + '.node')) return Module._extensions['.node'](module, main.replace(/\.asar/, '.asar.unpacked') + '.node')
      throw new Error('Cannot find module \'' + filename + '\'')
    } else if (fs.existsSync(indexjs)) {
      return Module._extensions['.js'](module, indexjs)
    } else if (fs.existsSync(indexjson)) {
      return Module._extensions['.json'](module, indexjson)
    } else if (fs.existsSync(indexnode) && fs.existsSync(indexnode.replace(/\.asar/, '.asar.unpacked'))) {
      return Module._extensions['.node'](module, indexnode.replace(/\.asar/, '.asar.unpacked'))
    } else {
      throw new Error('Cannot find module \'' + filename + '\'')
    }
  }
}
