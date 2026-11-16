import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../src/adapters/browser.js';
import { fileStorage } from '../src/adapters/node.js';
import { fetchTransport } from '../src/adapters/shared.js';
import { harness, MemoryStorage, settle } from './helpers.js';

const HEX = /^[a-f0-9]{32}$/;

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-16T08:00:00Z') }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('batch id', () => {
  it('sends 32 lowercase hex characters with every batch, and different batches have different ids', async () => {
    const h = harness(); await h.start({ gzip: false, maxBatchSize: 2 });
    for (let i = 0; i < 4; i++) h.client.track(`s${i}`);
    await h.client.flush();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]!.batch).toMatch(HEX); expect(h.requests[1]!.batch).toMatch(HEX);
    expect(h.requests[0]!.batch).not.toBe(h.requests[1]!.batch);
  });

  it.each([[{ status: 500 }], [{ status: 429, retryAfter: '1' }], [new Error('network')]])('keeps id and content on retry after %j', async failure => {
    const h = harness(); await h.start({ gzip: false }); h.responses.push(failure, { status: 202 });
    h.client.track('a'); h.client.track('b'); await h.client.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]!.batch).toMatch(HEX);
    expect(h.requests[1]!.batch).toBe(h.requests[0]!.batch);
    expect(h.signals(1)).toEqual(h.signals(0));
  });

  it('uses the same id after a restart with the in-flight batch persisted', async () => {
    const store = new MemoryStorage();
    const first = harness(store); await first.start({ gzip: false }); first.responses.push(new Error('lost'));
    first.client.track('a'); first.client.track('b'); await first.client.flush();
    const id = first.requests[0]!.batch!; expect(id).toMatch(HEX);
    expect(JSON.parse(store.value!).batches[0].id).toBe(id);
    vi.clearAllTimers();
    const second = harness(store); await second.start({ gzip: false }); await second.client.flush();
    expect(second.requests[0]!.batch).toBe(id);
    expect(second.signals(0)).toEqual(first.signals(0));
  });

  it('keeps the failed batch and its id when a signal is added before the retry, and gives the new signal its own batch id', async () => {
    const h = harness(); await h.start({ gzip: false }); h.responses.push({ status: 500 });
    h.client.track('a'); h.client.track('b'); await h.client.flush();
    h.client.track('c');
    await vi.advanceTimersByTimeAsync(5000); await h.client.flush();
    expect(h.requests.map(r => h.signals(h.requests.indexOf(r)).map(s => s.type))).toEqual([['a', 'b'], ['a', 'b'], ['c']]);
    expect(h.requests[1]!.batch).toBe(h.requests[0]!.batch);
    expect(h.requests[2]!.batch).toMatch(HEX); expect(h.requests[2]!.batch).not.toBe(h.requests[0]!.batch);
  });

  it('gives a new id when eviction removes the batch and the remaining signals are cut again', async () => {
    const h = harness(); await h.start({ gzip: false, maxQueueSize: 2 }); h.responses.push({ status: 500 });
    h.client.track('a'); h.client.track('b'); await h.client.flush();
    const first = h.requests[0]!.batch;
    h.client.track('c'); h.client.track('d');
    await vi.advanceTimersByTimeAsync(5000); await h.client.flush();
    expect(h.signals(1).map(s => s.type)).toEqual(['c', 'd']);
    expect(h.requests[1]!.batch).toMatch(HEX); expect(h.requests[1]!.batch).not.toBe(first);
  });

  it.each([400, 413])('gives each half a new id after a %i split', async status => {
    const h = harness(); await h.start({ gzip: false }); h.responses.push({ status });
    for (const t of ['a', 'b', 'c', 'd']) h.client.track(t);
    await h.client.flush();
    const ids = h.requests.map(r => r.batch!);
    expect(ids[0]).toMatch(HEX);
    expect(ids[1]).toMatch(HEX); expect(ids[2]).toMatch(HEX);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the id when a gzip 413 is retried uncompressed with the same JSON', async () => {
    const h = harness(); await h.start(); h.responses.push({ status: 413 }, { status: 202 });
    h.client.track('a', { props: { text: 'x'.repeat(2000) } }); await h.client.flush();
    expect(h.requests[1]!.batch).toBe(h.requests[0]!.batch);
  });

  it('sends an id on the keepalive page-hide send', async () => {
    const h = harness(); await h.start({ gzip: false });
    h.client.track('a'); h.hide(); await settle();
    expect(h.requests[0]!.keepalive).toBe(true);
    expect(h.requests[0]!.batch).toMatch(HEX);
  });

  it('keeps the id when a keepalive send fails and the normal retry follows', async () => {
    const h = harness(); await h.start({ gzip: false }); h.responses.push(new Error('dropped'), { status: 202 });
    h.client.track('a'); h.hide(); await settle();
    await vi.advanceTimersByTimeAsync(5000); await h.client.flush();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.keepalive).toBe(false);
    expect(h.requests[1]!.batch).toBe(h.requests[0]!.batch);
  });
});

describe('fetch transport', () => {
  it('sends X-Pulse-Batch on signal posts, and none when there is no id', async () => {
    const calls: RequestInit[] = [];
    const fetcher = async (_url: string, init: RequestInit) => { calls.push(init); return new Response('', { status: 202 }); };
    const transport = fetchTransport('k', 'https://example.invalid', () => fetcher as unknown as typeof fetch);
    await transport.send(new Uint8Array([91, 93]), false, true, 'a'.repeat(32));
    await transport.send(new Uint8Array([91, 93]), false, false);
    expect(calls[0]!.headers).toMatchObject({ 'X-Pulse-Batch': 'a'.repeat(32), 'X-App-Key': 'k' });
    expect(calls[0]!.keepalive).toBe(true);
    expect(calls[1]!.headers).not.toHaveProperty('X-Pulse-Batch');
  });

  it('the browser platform sends the header through fetch', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { calls.push(init); return new Response('', { status: 202 }); });
    await browserPlatform().transport('k', 'https://example.invalid').send(new Uint8Array([91, 93]), false, false, 'b'.repeat(32));
    expect(calls[0]!.headers).toMatchObject({ 'X-Pulse-Batch': 'b'.repeat(32) });
  });
});

describe('Node file queue', () => {
  let directory = '';
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'pulse-batch-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('persists the in-flight batch id in the queue file and reuses it after a restart', async () => {
    const path = join(directory, 'queue.json');
    const first = harness(fileStorage(path)); await first.start({ gzip: false }); first.responses.push(new Error('lost'));
    first.client.track('a'); await first.client.flush();
    const id = first.requests[0]!.batch!;
    expect(JSON.parse(await readFile(path, 'utf8')).batches[0].id).toBe(id);
    vi.clearAllTimers();
    const second = harness(fileStorage(path)); await second.start({ gzip: false }); await second.client.flush();
    expect(second.requests[0]!.batch).toBe(id);
  });
});

describe('queue saved by 0.9.4', () => {
  // Queue records written by version 0.9.4: batches carry indices and, once prepared, gzip and body, but no id.
  const saved = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

  it.each([['queue-0.9.4-gzip.json', 2], ['queue-0.9.4-split.json', 2]])('loads %s and sends with fresh ids', async (file, count) => {
    const record = JSON.parse(saved(file));
    expect(record.batches.every((b: { id?: string }) => b.id === undefined)).toBe(true);
    const store = new MemoryStorage(); store.value = saved(file);
    const h = harness(store); await h.start({ maxBatchSize: 2 }); await h.client.flush();
    expect(h.requests).toHaveLength(count);
    expect(h.signals(0).map(s => s.type)).toEqual(['a', 'b']); expect(h.signals(1).map(s => s.type)).toEqual(['c']);
    expect(h.requests[0]!.batch).toMatch(HEX); expect(h.requests[1]!.batch).toMatch(HEX);
    expect(h.requests[0]!.batch).not.toBe(h.requests[1]!.batch);
  });

  it('replaces a stored id that is not 32 lowercase hex characters', async () => {
    const record = JSON.parse(saved('queue-0.9.4-split.json'));
    record.batches[0].id = 'NOT-HEX';
    const store = new MemoryStorage(); store.value = JSON.stringify(record);
    const h = harness(store); await h.start({ maxBatchSize: 2 }); await h.client.flush();
    expect(h.requests[0]!.batch).toMatch(HEX);
  });
});
