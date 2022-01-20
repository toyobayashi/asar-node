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
assert.strictEqual(JSON.stringify(require('./app-default-entry-json')), JSON.stringify({ test: '123' }))
assert.strictEqual(JSON.stringify(require('./app-default-entry-json.asar')), JSON.stringify({ test: '123' }))
if (process.platform === 'win32') {
  assert.strictEqual(typeof require('./app-default-entry-node'), 'function')
  assert.strictEqual(typeof require('./app-default-entry-node.asar'), 'function')
}

require('./app-pkg-default-entry')
require('./app-pkg-default-entry.asar')
assert.strictEqual(JSON.stringify(require('./app-pkg-default-entry-json')), JSON.stringify({ test: '456' }))
assert.strictEqual(JSON.stringify(require('./app-pkg-default-entry-json.asar')), JSON.stringify({ test: '456' }))
if (process.platform === 'win32') {
  assert.strictEqual(typeof require('./app-pkg-default-entry-node'), 'function')
  assert.strictEqual(typeof require('./app-pkg-default-entry-node.asar'), 'function')
}

assert.throws(() => {
  require('./app-default-entry-error')
}, (err) => {
  return err.code === 'MODULE_NOT_FOUND'
})

require('./app-pkg-entry.asar')
assert.throws(() => {
  require('./app-default-entry-error')
}, (err) => {
  return err.code === 'MODULE_NOT_FOUND'
})
assert.throws(() => {
  require('./app-pkg-entry-error.asar')
}, (err) => {
  return err.code === 'MODULE_NOT_FOUND'
})
require('./app-default-entry-error.asar/_index.js')
require('./app-pkg-entry-error.asar/test/index.js')
