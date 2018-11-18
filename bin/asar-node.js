#!/usr/bin/env node

const path = require('path')
const args = process.argv.slice(2)
args.unshift('--require=' + path.join(path.dirname(process.argv[1]), '..'))
require('child_process').spawnSync(process.argv0, args, { stdio: 'inherit' })
