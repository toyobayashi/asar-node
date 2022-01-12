export { addAsarToLookupPaths, removeAsarToLookupPaths } from './lib/lookup'
export { register, unregister } from './lib/register'

export interface AsarState {
  lookupAsar: boolean;
  registered: boolean;
}

export function getState (): AsarState
export const version: string
