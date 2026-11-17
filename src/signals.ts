import { scrub } from './errors.js';

/** Types the SDK sends on its own. Everything but `pulse.error` counts toward the daily limit of an install. */
export const AUTOMATIC = ['pulse.session_started', 'pulse.new_install', 'pulse.app_updated', 'pulse.screen_view', 'pulse.app_opened',
  'pulse.app_backgrounded', 'pulse.deep_link', 'pulse.permission_changed'];
/** Automatic types that the portal must list in `enabledSignals` before they are sent. */
export const OPT_IN = ['pulse.app_opened', 'pulse.app_backgrounded'];
/** Automatic types that were added with the portal switches; they are judged when they are queued. */
export const ADDED = [...OPT_IN, 'pulse.deep_link', 'pulse.permission_changed'];
/** The most automatic signals of a type in one session. */
export const CAPS: Record<string, number> = {
  'pulse.app_opened': 20, 'pulse.app_backgrounded': 20, 'pulse.deep_link': 10, 'pulse.permission_changed': 5, 'pulse.screen_view': 100,
};
/** The most automatic signals of one install in one local day. */
export const DAILY = 300;

const ID = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/** A path with numeric and uuid-like segments replaced by `:id`. */
export const idPath = (path: string): string => path.split('/').map(part => ID.test(part) ? ':id' : part).join('/');

/** The three campaign tags of a URL's query, filtered and at most 64 characters each. Nothing else is read. */
export function utm(query: { get(name: string): string | null } | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['Source', 'Medium', 'Campaign']) {
    const value = query?.get(`utm_${name.toLowerCase()}`);
    if (value) out[`utm${name}`] = scrub(value).slice(0, 64);
  }
  return out;
}

/** The props of `pulse.deep_link`: scheme, host and path (ids as `:id`, at most 128), plus the campaign tags. Never the query or fragment. */
export function deepLinkProps(link: string): Record<string, string> {
  const url = new URL(link);
  return { scheme: url.protocol.slice(0, -1), host: url.hostname.slice(0, 128), path: idPath(url.pathname).slice(0, 128), ...utm(url.searchParams) };
}
