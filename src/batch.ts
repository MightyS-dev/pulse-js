import { encode } from './validation.js';
import type { Signal } from './types.js';

export interface Batch {
  signals: Signal[];
  bytes: Uint8Array;
  body?: Uint8Array | undefined;
  gzip: boolean;
  /** Server body-read timeouts (408) seen for these exact bytes in this runtime. */
  timeouts: number;
  /** Sent as `X-Pulse-Batch`: the same for every retry of these exact signals. */
  id?: string | undefined;
}

export function batchFrom(signals: Signal[], id?: string): Batch {
  return { signals, bytes: encode(JSON.stringify(signals)), gzip: false, timeouts: 0, id };
}

/** Prepared batches are stored first, in send order, so their indices stay contiguous after a partial eviction. */
export function saveState(work: Batch[], queue: Signal[]): { queue: Signal[]; batches: unknown[] } {
  const batched = work.flatMap(b => b.signals);
  const ordered = batched.concat(queue.filter(s => !batched.includes(s)));
  return {
    queue: ordered,
    batches: work.map(b => ({ indices: b.signals.map(s => ordered.indexOf(s)), ...(b.id ? { id: b.id } : {}),
      ...(b.body ? { gzip: b.gzip, ...(b.gzip ? { body: Array.from(b.body) } : {}) } : {}) })),
  };
}

/** Rebuilds stored batches; any malformed field rejects all of them, and their signals are sent as new batches. */
export function restoreBatches(input: unknown, queue: (Signal | undefined)[], newId: () => string | undefined): Batch[] {
  let previous = -1;
  const fail = (): never => { throw 0; };
  try {
    return (input as { indices: number[]; gzip?: unknown; body: number[]; id?: unknown }[]).map(item => {
      const { indices, body, id } = item;
      if (!indices.length || indices.length > 1000) fail();
      // Batches cover the front of the stored queue, in order and without gaps.
      const batch = batchFrom(indices.map(index => index === ++previous && queue[index] || fail()),
        // A batch saved before ids existed, or with a damaged id, is sent under a new one.
        typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? id : newId());
      if (batch.bytes.byteLength > 1048576) fail();
      if (item.gzip === true) {
        if (!(body.length <= 2097152 && body[0] === 31 && body[1] === 139 && body.every(n => Number.isInteger(n) && n >= 0 && n < 256))) fail();
        batch.body = new Uint8Array(body);
        batch.gzip = true;
      } else if (item.gzip === false) batch.body = batch.bytes;
      return batch;
    });
  } catch { return []; }
}
