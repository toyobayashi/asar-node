const path = require('path')
const { EOL } = require('os')
const webpack = require('webpack')

const createTarget = (entry, needShebang) => {
  return {
    mode: 'production',
    devtool: false,
    target: 'node',
    entry,
    output: {
      path: path.join(__dirname, '../dist'),
      library: {
        type: 'commonjs2'
      }
    },
    plugins: [
      new webpack.DefinePlugin({
        __ASAR_NODE_VERSION__: JSON.stringify(require('../package.json').version)
      }),
      ...(needShebang
        ? [new webpack.BannerPlugin({ banner: '#!/usr/bin/env node' + EOL, raw: true })]
        : [])
    ]
  }
}

webpack([
  createTarget({
    index: [path.join(__dirname, '../index.js')]
  }, false),
  createTarget({
    autorun: [path.join(__dirname, '../lib/autorun/index.js')]
  }, false),
  createTarget({
    'autorun-lookup': [path.join(__dirname, '../lib/autorun/lookup.js')]
  }, false),
  createTarget({
    'autorun-register': [path.join(__dirname, '../lib/autorun/register.js')]
  }, false),
  createTarget({
    'asar-node': [path.join(__dirname, '../bin/asar-node.js')]
  }, true)
], (err, stats) => {
  if (err) {
    console.error(err)
    return
  }

  console.log(stats.toString({ colors: true }))
})
