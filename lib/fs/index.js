const nodeRequire = require('./require.js')()

/** @type {typeof import('fs')} */
const fs = ('electron' in process.versions) ? nodeRequire('original-fs') : require('fs')

module.exports = fs
