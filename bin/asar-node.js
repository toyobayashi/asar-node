#!/usr/bin/env node

require('child_process').spawnSync('node', process.argv.slice(1).unshift('--require=asar-node'), { stdio: 'inherit' })
