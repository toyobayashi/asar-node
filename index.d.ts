export { addAsarToLookupPaths, removeAsarToLookupPaths } from './lib/lookup'
export { register, unregister } from './lib/register'

export declare interface AsarState {
  lookupAsar: boolean;
  registered: boolean;
}

export declare function getState (): AsarState
export declare const version: string
