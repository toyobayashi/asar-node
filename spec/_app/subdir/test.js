console.log(`[subdir/test] ${__filename}`)
const fs = require('fs')
const path = require('path')
const assert = require('assert')
// eslint-disable-next-line no-template-curly-in-string
fs.writeFileSync(path.join(__dirname, '../../out.js'), 'console.log(`[out] ${__filename}`)\nmodule.exports = \'out\'\n')
assert.ok(fs.existsSync(path.join(__dirname, '../../out.js')))
console.log('[subdir/test] ' + fs.statSync(__dirname).isDirectory())
console.log('[subdir/test] ' + fs.statSync(__filename).isDirectory())
console.log('[subdir/test] ' + fs.statSync(__filename).size)

const out = require('../../out.js')
console.log('[subdir/test] ' + out)
module.exports = {
  inner: 'inner',
  out: out
}
