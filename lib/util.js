exports.splitPath = function (p) {
  if (typeof p !== 'string') return [false]
  if (p.endsWith('.asar')) return [true, p, '']
  const indexWindows = p.lastIndexOf('.asar\\')
  const indexPosix = p.lastIndexOf('.asar/')
  if (indexWindows === -1 && indexPosix === -1) return [false]
  const index = indexPosix === -1 ? indexWindows : indexPosix
  return [true, p.substring(0, index + 5), p.substring(index + 6)]
}
