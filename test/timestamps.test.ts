import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Signal } from '../src/types.js';
import { harness, InstallStorage, settle } from './helpers.js';

class UsageStorage extends InstallStorage {
  text: string | null = null;
  usage = {
    read: async (): Promise<string | null> => this.text,
    write: async (value: string): Promise<void> => { this.text = value; },
    remove: async (): Promise<void> => { this.text = null; },
  };
}

const START = new Date(2026, 10, 15, 12).getTime();
beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const sent = async (h: ReturnType<typeof harness>): Promise<Signal[]> => {
  await h.client.flush();
  return h.requests.flatMap((_, i) => h.signals(i));
};
const stamps = (signals: Signal[]): number[] => signals.map(s => Date.parse(s.timestamp));
const types = (signals: Signal[]): string[] => signals.map(s => s.type);

describe('signal timestamps', () => {
  it('gives three signals captured in the same millisecond +0, +1 and +2 ms', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.track('a'); h.client.track('b'); h.client.track('c');
    const signals = await sent(h);
    expect(types(signals)).toEqual(['a', 'b', 'c']);
    expect(stamps(signals)).toEqual([START, START + 1, START + 2]);
  });

  it('puts the automatic signals before the signal that started the session, with smaller timestamps', async () => {
    const h = harness(new UsageStorage());
    await h.start({ gzip: false });
    h.client.track('first'); h.client.track('second');
    const signals = await sent(h);
    expect(types(signals)).toEqual(['pulse.new_install', 'pulse.session_started', 'first', 'second']);
    expect(stamps(signals)).toEqual([START, START + 1, START + 2, START + 3]);
  });

  it('keeps the capture order of signals tracked before init', async () => {
    const h = harness();
    h.client.track('a'); h.client.track('b');
    await h.start({ gzip: false });
    h.client.track('c');
    const signals = await sent(h);
    expect(types(signals)).toEqual(['a', 'b', 'c']);
    expect(stamps(signals)).toEqual([START, START + 1, START + 2]);
  });

  it('keeps increasing when the clock goes backwards', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.track('a');
    vi.setSystemTime(START - 5000);
    h.client.track('b'); h.client.track('c');
    const signals = await sent(h);
    expect(types(signals)).toEqual(['a', 'b', 'c']);
    expect(stamps(signals)).toEqual([START, START + 1, START + 2]);
  });

  it('keeps a later clock reading as it is', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.track('a');
    vi.setSystemTime(START + 2000);
    h.client.track('b');
    await settle();
    expect(stamps(await sent(h))).toEqual([START, START + 2000]);
  });
});
