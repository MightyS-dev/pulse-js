/** The fixed Pulse host URL of the overlay module; normal visitors never load it. */
export const OVERLAY_URL: string = 'https://pulse.mightys.dev/sdk/heatmap-overlay.js';
/** The fragment parameter the portal adds to the customer's page (the API contract names none). */
export const OVERLAY_PARAM = 'pulse_overlay';

/** Splits a hash into the overlay token and the hash without it. Other hash content stays exactly as it was. */
export function takeToken(hash: string): { token: string | undefined; rest: string } {
  const parts = hash.replace(/^#/, '').split('&');
  const own = parts.find(p => p.startsWith(`${OVERLAY_PARAM}=`));
  if (own === undefined) return { token: undefined, rest: hash };
  const rest = parts.filter(p => p !== own).join('&');
  const token = decodeURIComponent(own.slice(OVERLAY_PARAM.length + 1));
  // The server accepts 20 to 200 characters; anything else is not a token and is left alone after removal.
  return { token: token.length >= 20 && token.length <= 200 && !/\s/.test(token) ? token : undefined, rest: rest ? `#${rest}` : '' };
}

/**
 * Reads the overlay token from the address bar, removes it at once with `history.replaceState` (the rest of the hash
 * stays) and loads the overlay module. The token is never sent to the signal endpoint. The server checks the origin.
 */
export function startOverlay(win: Record<string, any>, host: string, load: (url: string) => Promise<any> = url => import(/* @vite-ignore */ url)): void {
  try {
    const location = win.location as Location | undefined;
    if (!location?.hash.includes(OVERLAY_PARAM)) return;
    const { token, rest } = takeToken(location.hash);
    if (rest === location.hash) return;
    (win.history as History).replaceState(win.history.state, '', location.pathname + location.search + rest);
    if (token) void load(OVERLAY_URL).then(m => m.mount({ token, host })).catch(() => {});
  } catch { /* Never affects the page. */ }
}
