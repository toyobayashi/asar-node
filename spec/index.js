require('..')

require('./app')
require('./app-default-entry.asar')
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
