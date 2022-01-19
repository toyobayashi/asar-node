# asar-node

Enable `require('./path/to/any-node-project.asar')` & `require('./path/to/any-node-project.asar/any/file')` in your nodejs app.

## Usage

### CLI

``` bash
$ npm install -g asar-node
```

``` bash
$ asar-node ./path/to/any-node-project
$ asar-node ./path/to/any-node-project.asar

$ asar-node ./path/to/any-node-project.asar/any/file
$ asar-node ./path/to/any-node-project.asar/any/file.js
$ asar-node ./path/to/any-node-project.asar/any/file.json
$ asar-node ./path/to/any-node-project.asar/any/file.node
```

### Programming

``` bash
$ npm install asar-node
```

```js
require('asar-node').register()
// Equivalent to require('asar-node/lib/register.js').register()

require('./path/to/any-node-project') // like require a nodejs directory
// or require('./path/to/any-node-project.asar')
require('./path/to/any-node-project.asar/any/file')
```

If require a asar file, make sure there is `package.json` and `main` field or `index.js` / `index.json` / `index.node` in the asar root.

You can also pack `node_modules` into `node_modules.asar` instead of packing the hole project folder into an asar file.

To let node find modules from `node_modules.asar`, You should

``` js
const { register, addAsarToLookupPaths } = require('asar-node')
// Equivalent to 
// const register = require('asar-node/lib/register.js').register
// const addAsarToLookupPaths = require('asar-node/lib/lookup.js').addAsarToLookupPaths

register()
addAsarToLookupPaths()

const Koa = require('koa') // koa is in node_modules.asar
```

In an electron project, it's unnecessary to call `register()` but you can also call `addAsarToLookupPaths()` to enable `node_modules.asar` support.

To disable asar support, you can set `process.noAsar = true` or `ELECTRON_NO_ASAR` environmnet variable.

## Migration

v1.x

``` js
require('asar-node')
```

v2.x / v3.x

``` js
require('asar-node/lib/autorun/index')
```

## Available APIs inside asar

* `fs.readFileSync` / `fs.readFile` / `fs.promises.readFile`
* `fs.statSync` / `fs.stat` / `fs.promises.stat`
* `fs.lstatSync` / `fs.lstat` / `fs.promises.lstat`
* `fs.readdirSync` / `fs.readdir` / `fs.promises.readdir`
* `fs.existsSync` / `fs.exists`
* `fs.accessSync` / `fs.access` / `fs.promises.access`
* `fs.realpathSync` / `fs.realpath` / `fs.realpathSync.native` / `fs.realpath.native` / `fs.promises.realpath`
* `fs.copyFileSync` / `fs.copyFile` / `fs.promises.copyFile`
* `fs.openSync` / `fs.open` / `fs.promises.open`
* `fs.createReadStream`
* `child_process.execFile`
* `child_process.execFileSync`
* `child_process.fork`

## Note

* **If your nodejs project use C++ native addons, please unpack it from asar file by specifying `--unpack=*.node` to [asar CLI](https://www.npmjs.com/package/asar)**
* **Express or Koa serving static file in asar file is not supported, but you can unpack the static file folder.**
