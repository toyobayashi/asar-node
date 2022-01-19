const log = (...args) => {
  console.log('[_app/index.js]', ...args)
}
log(__filename)
log(__dirname)

const assert = require('assert')
const fs = require('fs')
const path = require('path')

assert.ok(typeof require('nodemodule') === 'function')
assert.ok(typeof require('nodemodule/index') === 'function')
assert.ok(typeof require('nodemodule/index.js') === 'function')
if (process.platform === 'win32') {
  assert.ok(typeof require('nodeaddon') === 'function')
  assert.ok(typeof require('nodeaddon/index') === 'function')
  assert.ok(typeof require('nodeaddon/index.node') === 'function')
}

const inner = require('./subdir/test').inner
const out = require('./subdir/test.js').out
assert.strictEqual(inner, 'inner')
assert.strictEqual(out, 'out')

let size = 0
fs.createReadStream(path.join(__dirname, './subdir/test.js'), 'utf8')
  .on('data', (data) => { size += data.length })
  .on('close', () => {
    log(`[index] size: ${size}`)
    assert.ok(size > 0)
  })
