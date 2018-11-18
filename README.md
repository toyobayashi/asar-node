# asar-node

Enable require('./path/to/any-node-project.asar') & require('./path/to/any-node-project.asar/any/file') in your nodejs app.

`asar-node` can not be used in Electron.

Or just run `asar-node ./path/to/any-node-project.asar`

## Usage

Exists `./path/to/any-node-project.asar`

``` bash
$ asar-node ./path/to/any-node-project # OK!
$ asar-node ./path/to/any-node-project.asar # OK!

$ asar-node ./path/to/any-node-project.asar/any/file # OK!
$ asar-node ./path/to/any-node-project.asar/any/file.js # OK!
$ asar-node ./path/to/any-node-project.asar/any/file.json # OK!
$ asar-node ./path/to/any-node-project.asar/any/file.node # OK!
```

Or

```js
require('asar-node')

require('./path/to/any-node-project') // like require a nodejs directory
// or require('./path/to/any-node-project.asar')
require('./path/to/any-node-project.asar/any/file')
```

If require a asar file, make sure there is `package.json` and `main` field or `index.js` in the asar root.

**Note: Only these fs api functions are available and you should use absolute path. Also `child_process` api is not supported in asar file.**

* fs.readFileSync()
* fs.createReadStream()
* fs.statSync()
* fs.existsSync()
* fs.realpathSync()
