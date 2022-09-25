/** 
 * Hack module and fs API
 * @example
 * You can do something like this.
 * 
 * ``` js
 * require('./path/to/file.asar')
 * require('./path/to/file.asar/subdir/script.js')
 * require('./path/to/file.asar/subdir/config.json')
 * require('./path/to/file.asar/subdir/addon.node')
 * ```
 */ 
export declare function register(): void;

export declare function unregister(): void;

export declare function checkRegisterState (): boolean;
