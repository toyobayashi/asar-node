#!/usr/bin/env node

require('asar-node')
const Module = require('module')
const path = require('path')

function main (argc, argv) {
  const args = argv.slice(2)
  if (args[0] === '-v' || args[0] === '--version') {
    console.log('node: ' + process.version)
    console.log('asar-node: ' + require('asar-node/package.json').version)
    return
  }

  if (args[0] === '-h' || args[0] === '--help') {
    console.log(`
Usage: asar-node [options] [arguments]
Options:
  -r, --require [path]           Require a node module before execution
  -h, --help                     Print CLI usage
  -v, --version                  Print module version information
`)
    return
  }

  const options = {
    '-r': String,
    '--require': String
  }

  const preloadRequests = []

  let i = 0

  for (i = 0; i < argc; i++) {
    if (args[i] in options) {
      if (options[args[i]] === Boolean) {
        process.execArgv.push(args[i])
      } else {
        process.execArgv.push(args[i])
        process.execArgv.push(args[i + 1])

        if (args[i] === '-r' || args[i] === '--require') {
          preloadRequests.push(args[i + 1])
        }
        i++
      }
    } else {
      break
    }
  }

  process.argv = [argv[0]].concat(path.join(process.cwd(), args.slice(i)[0])).concat(args.slice(i + 1))

  Module._preloadModules(preloadRequests)
  Module.runMain()
}

main(process.argv.length, process.argv)
