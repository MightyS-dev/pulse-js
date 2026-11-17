import { idPath } from '../signals.js';

/** A route as a screen name: the path only (the hash path for hash routers), numeric and uuid-like segments as `:id`. */
export function routeName(pathname: string, hash = ''): string {
  const path = (/^#!?\//.test(hash) ? hash.replace(/^#!?/, '') : pathname).split(/[?#]/)[0] ?? '';
  return idPath(path).slice(0, 128) || '/';
}
