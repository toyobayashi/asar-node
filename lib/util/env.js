const envNoAsar = !!(process.env.ELECTRON_NO_ASAR &&
  process.type !== 'browser' &&
  process.type !== 'renderer')
const isAsarDisabled = () => !!(process.noAsar || envNoAsar)

function getModuleConstructor () {
  let Module
  try {
    Module = require('module')
  } catch (_) {}
  return Module
}

exports.envNoAsar = envNoAsar
exports.isAsarDisabled = isAsarDisabled
exports.getModuleConstructor = getModuleConstructor
