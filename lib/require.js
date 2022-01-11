function getNodeRequire () {
  let nativeRequire
  if (typeof __webpack_public_path__ !== 'undefined') {
    nativeRequire = /*#__PURE__*/ (function () {
      return typeof __non_webpack_require__ !== 'undefined' ? __non_webpack_require__ : undefined
    })()
  } else {
    nativeRequire = /*#__PURE__*/ (function () {
      return typeof __webpack_public_path__ !== 'undefined'
        ? (typeof __non_webpack_require__ !== 'undefined' ? __non_webpack_require__ : undefined)
        : (typeof require !== 'undefined' ? require : undefined)
    })()
  }
  return nativeRequire
}

module.exports = getNodeRequire
