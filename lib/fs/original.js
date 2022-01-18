const fs = require('./index.js')

const originalFs = {}

const descs = { ...Object.getOwnPropertyDescriptors(fs) }
delete descs.promises
Object.defineProperties(originalFs, descs)

const originalFsPromises = {}
Object.defineProperties(originalFsPromises, {
  ...Object.getOwnPropertyDescriptors(fs.promises)
})

Object.defineProperty(originalFs, 'promises', {
  configurable: true,
  enumerable: true,
  get () {
    return originalFsPromises
  }
})

module.exports = originalFs
