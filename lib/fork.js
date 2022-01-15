const args = process.argv.splice(2, 3)

const register = require('./register.js')
const lookup = require('./lookup.js')

if (args[0] === '1') {
  register.register()
}

if (args[1] === '1') {
  lookup.addAsarToLookupPaths()
}

require('module')._load(args[2], null, true)
