console.log(`[index] ${__filename}`)
console.log(1)
console.log(require('nodemodule'))
console.log(require('nodemodule/index'))
console.log(require('nodemodule/index.js'))
if (process.platform === 'win32') {
  console.log(2)
  console.log(require('nodeaddon'))
  console.log(require('nodeaddon/index'))
  console.log(require('nodeaddon/index.node'))
}

const fs = require('fs')
const path = require('path')
const assert = require('assert')

console.log('[readdirSync]')
console.log(fs.readdirSync(path.join(__dirname)))
console.log(fs.readdirSync(path.join(__dirname, './node_modules')))
console.log(fs.readdirSync(path.join(__dirname, './subdir')))
console.log(fs.readdirSync(path.join(__dirname, '../_app')))
try {
  console.log(fs.readdirSync(path.join(__dirname, './index.js')))
} catch (err) {
  console.log(err.message)
}
try {
  console.log(fs.readdirSync(path.join(__dirname, './notexists')))
} catch (err) {
  console.log(err.message)
}
try {
  console.log(fs.readdirSync(path.join(__dirname, './notexists/notexists')))
} catch (err) {
  console.log(err.message)
}

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

let size2 = 0
fs.createReadStream(path.join(__dirname, './package.json'), 'utf8')
  .on('data', (data) => { size2 += data.length; console.log('[stream]\n' + data) })
  .on('close', () => {
    console.log(`[index] size: ${size2}`)
  })
