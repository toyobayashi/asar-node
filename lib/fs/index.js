const nodeRequire = require('./require.js')()

let fs
try {
  fs = nodeRequire('original-fs')
} catch (_) {
  fs = require('fs')
}

module.exports = fs
