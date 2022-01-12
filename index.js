const lookup = require('./lib/lookup.js')
const register = require('./lib/register.js')

function getState () {
  return {
    lookupAsar: lookup.checkLookupState(),
    registered: register.checkRegisterState()
  }
}

exports.addAsarToLookupPaths = lookup.addAsarToLookupPaths
exports.removeAsarToLookupPaths = lookup.removeAsarToLookupPaths
exports.register = register.register
exports.unregister = register.unregister
exports.getState = getState
exports.version = typeof __ASAR_NODE_VERSION__ !== 'undefined' ? __ASAR_NODE_VERSION__ : require('./package.json').version
