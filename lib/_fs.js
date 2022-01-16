const nodeRequire = require('./require.js')()

/** @type {typeof import('fs')} */
const fs = process.versions.electron ? nodeRequire('original-fs') : require('fs')

module.exports = fs
