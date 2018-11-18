let Module
try {
  Module = require('module')
} catch (_error) {
  Module = null
}

const path = require('path')
const fs = require('./fs.js')
const { toAbsolute, splitPath } = require('./util.js')

function checkFilename (request, absolutePath) {
  if (!path.isAbsolute(absolutePath)) throw new Error('Not absolute path.')
  if (path.extname(absolutePath) !== '') {
    if (fs.existsSync(absolutePath)) return absolutePath
    throw new Error('Cannot find module \'' + request + '\'')
  }
  if (fs.existsSync(absolutePath + '.js')) return absolutePath + '.js'
  if (fs.existsSync(absolutePath + '.json')) return absolutePath + '.json'
  if (fs.existsSync(absolutePath + '.node')) return absolutePath + '.node'
  throw new Error('Cannot find module \'' + request + '\'')
}

// if (Module && Module._resolveLookupPaths) {
//   const oldResolveLookupPaths = Module._resolveLookupPaths
//   Module._resolveLookupPaths = function (request, parent, newReturn) {
//     const result = oldResolveLookupPaths(request, parent, newReturn)

//     const paths = newReturn ? result : result[1]
//     let length = paths.length
//     for (let i = 0; i < length; i++) {
//       if (path.basename(paths[i]) === 'node_modules') {
//         paths.splice(i + 1, 0, paths[i] + '.asar')
//         length = paths.length
//       }
//     }

//     return result
//   }
// }

if (Module && Module._findPath) {
  const oldFindPath = Module._findPath
  Module._findPath = function (request, paths, isMain) {
    const [isAsar, asarPath, filePath] = splitPath(request)
    if (!isAsar) return oldFindPath.apply(this, arguments)
    if (filePath === '') {
      const pkgPath = toAbsolute(path.join(asarPath, 'package.json'))
      const indexjs = toAbsolute(path.join(asarPath, 'index.js'))
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        pkg.main = pkg.main || 'index.js'
        const main = toAbsolute(path.join(asarPath, pkg.main))
        return checkFilename(request, main)
      } else if (fs.existsSync(indexjs)) {
        return indexjs
      } else {
        throw new Error('Cannot find module \'' + request + '\'')
      }
    }

    const absoluteRequest = toAbsolute(request)
    return checkFilename(request, absoluteRequest)
  }
}

if (Module && Module._resolveFilename) {
  const oldResolveFilename = Module._resolveFilename
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (path.isAbsolute(request) || request.charAt(0) === '.') {
      if (parent) {
        let paths
        if (typeof options === 'object' && options !== null &&
          Array.isArray(options.paths)) {
          const fakeParent = new Module('', null)

          paths = []

          for (let i = 0; i < options.paths.length; i++) {
            const path = options.paths[i]
            fakeParent.paths = Module._nodeModulePaths(path)
            const lookupPaths = Module._resolveLookupPaths(request, fakeParent, true)

            if (!paths.includes(path)) paths.push(path)

            for (let j = 0; j < lookupPaths.length; j++) {
              if (!paths.includes(lookupPaths[j])) paths.push(lookupPaths[j])
            }
          }
        } else {
          paths = Module._resolveLookupPaths(request, parent, true)
        }
        const index = parent.filename.lastIndexOf('.asar')
        if (index !== -1) {
          const absoluteRequest = toAbsolute(path.join(path.extname(parent.filename) === '.asar' ? parent.filename : path.dirname(parent.filename), request))
          return checkFilename(request, absoluteRequest)
        }
      }
    }

    return oldResolveFilename.apply(this, arguments)
  }
}

if (Module && Module._extensions) {
  Module._extensions['.asar'] = Module._extensions['.asar'] || function (module, filename) {
    const pkgPath = toAbsolute(path.join(filename, 'package.json'))
    const indexjs = toAbsolute(path.join(filename, 'index.js'))
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      pkg.main = pkg.main || 'index.js'
      const main = toAbsolute(path.join(filename, pkg.main))
      if (path.extname(main) !== '') {
        if (fs.existsSync(main)) return Module._extensions[path.extname(main)](module, main)
        throw new Error('Cannot find module \'' + filename + '\'')
      }
      if (fs.existsSync(main + '.js')) return Module._extensions['.js'](module, main + '.js')
      if (fs.existsSync(main + '.json')) return Module._extensions['.json'](module, main + '.json')
      if (fs.existsSync(main + '.node')) return Module._extensions['.node'](module, main + '.node')
      throw new Error('Cannot find module \'' + filename + '\'')
    } else if (fs.existsSync(indexjs)) {
      return Module._extensions['.js'](module, indexjs)
    } else {
      throw new Error('Cannot find module \'' + filename + '\'')
    }
  }
}
