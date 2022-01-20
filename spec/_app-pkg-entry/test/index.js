const log = (...args) => {
  console.log('[_app-pkg-entry/test/index.js]', ...args)
}
log(__filename)
