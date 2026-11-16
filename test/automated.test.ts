import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automatedBrowser, browserPlatform } from '../src/adapters/browser.js';
import { harness } from './helpers.js';

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-16T08:00:00Z') }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const BOTS = [
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1)',
  'Mozilla/5.0 (compatible; bingbot/2.0)', 'Mozilla/5.0 (Macintosh) Version/17 Safari/605.1.15 (Applebot/0.1)',
  'DuckDuckBot/1.1', 'Mozilla/5.0 (compatible; YandexBot/3.0)', 'Mozilla/5.0 (compatible; Baiduspider/2.0)',
  'facebookexternalhit/1.1', 'Twitterbot/1.0', 'LinkedInBot/1.0', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (compatible; Discordbot/2.0)',
  'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36', 'Mozilla/5.0 Lighthouse', 'Mozilla/5.0 Chrome-Lighthouse', 'Google Page Speed Insights PageSpeed',
  'Mozilla/5.0 GTmetrix', 'Pingdom.com_bot_version_1.4', 'SomeCrawler/1.0', 'Mozilla/5.0 (compatible; Spider)', 'acme-bot/1.0', 'MYBOT/1.0 (x)',
];
const NORMAL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
];

describe('automated browser detection', () => {
  it.each(BOTS)('detects %s', ua => { expect(automatedBrowser({ userAgent: ua })).toBe(true); });
  it.each(NORMAL)('lets %s send', ua => { expect(automatedBrowser({ userAgent: ua })).toBe(false); });
  it('detects webdriver true, also in a native wrapper, but not false or absent', () => {
    expect(automatedBrowser({ userAgent: NORMAL[0]!, webdriver: true })).toBe(true);
    expect(automatedBrowser({ userAgent: NORMAL[0]!, webdriver: true }, true)).toBe(true);
    expect(automatedBrowser({ userAgent: NORMAL[0]!, webdriver: false })).toBe(false);
    expect(automatedBrowser(undefined)).toBe(false);
  });
  it('ignores the user agent list inside a native wrapper', () => {
    expect(automatedBrowser({ userAgent: BOTS[0]! }, true)).toBe(false);
  });
  it('is wired into the browser platform', () => {
    vi.stubGlobal('navigator', { userAgent: BOTS[1] });
    expect(browserPlatform().automated?.()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: NORMAL[0] });
    expect(browserPlatform().automated?.()).toBe(false);
  });
});

describe('client in an automated browser', () => {
  it('sends nothing, stores nothing and uses no network, even for earlier and later signals', async () => {
    const writes: string[] = [];
    const h = harness({ read: async () => null, write: async v => { writes.push(v); } });
    h.platform.automated = () => true;
    const stored = vi.spyOn(h.platform, 'storage');
    h.client.track('early');
    await h.start({ gzip: false });
    h.client.track('late'); h.client.screen('home'); await h.client.setUser('u'); h.hide();
    await h.client.flush(); await vi.advanceTimersByTimeAsync(120000);
    expect(h.requests).toHaveLength(0); expect(writes).toHaveLength(0); expect(stored).not.toHaveBeenCalled();
    expect(h.screens).toHaveLength(0);
  });

  it('sends when allowAutomatedBrowsers is true', async () => {
    const h = harness();
    h.platform.automated = () => true;
    await h.start({ gzip: false, allowAutomatedBrowsers: true });
    h.client.track('x'); await h.client.flush();
    expect(h.signals()[0]!.type).toBe('x');
  });

  it('sends in a normal browser', async () => {
    const h = harness();
    h.platform.automated = () => false;
    await h.start({ gzip: false });
    h.client.track('x'); await h.client.flush();
    expect(h.requests).toHaveLength(1);
  });
});
