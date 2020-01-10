require('../lib/autorun/index.js')
const fs = require('fs')
const path = require('path')
require('./app')

console.log('=============================\n')
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

require('./app-pkg-entry.asar')
try {
  require('./app-default-entry-error')
} catch (error) {
  console.log(error.message)
}
try {
  require('./app-pkg-entry-error.asar')
} catch (error) {
  console.log(error.message)
}
require('./app-default-entry-error.asar/_index.js')
require('./app-pkg-entry-error.asar/test/index.js')

console.log('[readdirSync]')
console.log(fs.readdirSync(path.join(__dirname, './app.asar')))
console.log(fs.readdirSync(path.join(__dirname, './app.asar/subdir')))
try {
  console.log(fs.readdirSync(path.join(__dirname, './app.asar/index.js')))
} catch (err) {
  console.log(err.message)
}
try {
  console.log(fs.readdirSync(path.join(__dirname, './app.asar/notexists')))
} catch (err) {
  console.log(err.message)
}
try {
  console.log(fs.readdirSync(path.join(__dirname, './app.asar/notexists/notexists')))
} catch (err) {
  console.log(err.message)
}

console.log('=============================\n')
