const path = require('path')

const mainDir = require.main ? path.dirname(require.main.filename) : process.cwd()

exports.toAbsolute = function (p) {
  return path.isAbsolute(p) ? p : path.join(mainDir, p)
}

exports.splitPath = function (p) {
  if (typeof p !== 'string') return [false]
  if (p.substr(-5) === '.asar') return [true, p, '']
  const indexWindows = p.lastIndexOf('.asar\\')
  const indexPosix = p.lastIndexOf('.asar/')
  if (indexWindows === -1 && indexPosix === -1) return [false]
  const index = indexPosix === -1 ? indexWindows : indexPosix
  return [true, p.substr(0, index + 5), p.substr(index + 6)]
}

exports.internalModules = [
  'assert',
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
]
