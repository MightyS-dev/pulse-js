/** Opens a store page or link: in an app wrapper through the system (Capacitor, Cordova) or by navigation, in a browser in a new tab. */
export function openUrl(url: string, wrapper: boolean, win: Record<string, any> = globalThis): void {
  try {
    if (!wrapper) win.open?.(url, '_blank', 'noopener');
    else if (win.Capacitor?.isNativePlatform?.() === true || win.cordova !== undefined) win.open(url, '_system');
    else win.location.href = url;
  } catch { /* A link that cannot be opened leaves the screen as it is. */ }
}
