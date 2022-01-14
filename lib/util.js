const { statSync, existsSync } = require('fs')

exports.splitPath = function (p) {
  if (typeof p !== 'string') return [false]
  if (p.endsWith('.asar')) {
    let value
    if (existsSync(p) && statSync(p).isFile()) {
      value = [true, p, '']
    } else {
      value = [false]
    }
    return value
  }
  const indexWindows = p.lastIndexOf('.asar\\')
  const indexPosix = p.lastIndexOf('.asar/')
  if (indexWindows === -1 && indexPosix === -1) return [false]
  const index = indexPosix === -1 ? indexWindows : indexPosix

  const archive = p.substring(0, index + 5)

  let value
  if (existsSync(archive) && statSync(archive).isFile()) {
    value = [true, archive, p.substring(index + 6)]
  } else {
    value = [false]
  }

  return value
}
