require('../lib/autorun/index.js')
// require('../dist/index').register()
// require('../dist/index').addAsarToLookupPaths()
const fs = require('fs')
const path = require('path')
const assert = require('assert')

function deleteCache () {
  for (const k in require.cache) {
    if (k.indexOf('app.asar') !== -1) {
      delete require.cache[k]
    }
  }
}

require('./app')
console.log('\n======== DELETE CACHE ========\n')
deleteCache()
require('./app.asar')
console.log('\n================\n')
require('./_app-node-modules-asar/index.js')

console.log('\n================\n')
require('./app-default-entry')
require('./app-default-entry.asar')
console.log(require('./app-default-entry-json'))
console.log(require('./app-default-entry-json.asar'))
if (process.platform === 'win32') {
  console.log(require('./app-default-entry-node'))
  console.log(require('./app-default-entry-node.asar'))
}

require('./app-pkg-default-entry')
require('./app-pkg-default-entry.asar')
console.log(require('./app-pkg-default-entry-json'))
console.log(require('./app-pkg-default-entry-json.asar'))
if (process.platform === 'win32') {
  console.log(require('./app-pkg-default-entry-node'))
  console.log(require('./app-pkg-default-entry-node.asar'))
}

assert.throws(() => {
  require('./app-default-entry-error')
})

require('./app-pkg-entry.asar')
assert.throws(() => {
  require('./app-default-entry-error')
})
assert.throws(() => {
  require('./app-pkg-entry-error.asar')
})
require('./app-default-entry-error.asar/_index.js')
require('./app-pkg-entry-error.asar/test/index.js')
