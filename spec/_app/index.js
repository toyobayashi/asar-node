console.log(`[index] ${__filename}`)

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const inner = require('./subdir/test').inner
const out = require('./subdir/test.js').out
console.log(`[index] ${inner}`)
console.log(`[index] ${out}`)
assert.strictEqual(inner, 'inner')
assert.strictEqual(out, 'out')

console.log(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'))
console.log(fs.readFileSync(path.join(__dirname, './package.json'), 'utf8'))

let size = 0
fs.createReadStream(path.join(__dirname, './subdir/test.js'), 'utf8')
  .on('data', (data) => { size += data.length; console.log('[stream]\n' + data) })
  .on('close', () => {
    console.log(`[index] size: ${size}`)
  })
