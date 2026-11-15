import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { gzip as zip } from 'node:zlib';
import { fetchTransport, realClock, resilientStorage } from './shared.js';
import type { Platform, Storage } from '../types.js';

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function writeText(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(value, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** A queue file plus a consent file. A consent file that exists but cannot be read is treated as opted out. */
export function fileStorage(path: string, consentPath = `${path}.consent`): Storage {
  return resilientStorage({
    read: () => readText(path),
    write: value => writeText(path, value),
    consent: { read: () => readText(consentPath), write: value => writeText(consentPath, value) },
  });
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * The default layout for several processes: each SDK instance writes `<key>.<pid>.<uuid>.queue`, and all share
 * `<key>.json` for consent. On start, queue files of exited processes are adopted. The atomic rename lets only one
 * process take a file; the taken file is deleted after its signals are stored in the new owner's queue.
 */
export function instanceStorage(directory: string, key: string, pid = process.pid, alive = processAlive): Storage {
  const name = (): string => join(directory, `${key}.${pid}.${randomUUID()}.queue`);
  const pattern = /^([0-9a-f]{64})\.(\d+)\.[0-9a-f-]{36}\.queue$/;
  return {
    ...fileStorage(name(), join(directory, `${key}.json`)),
    async claim() {
      const values: string[] = [];
      const taken: string[] = [];
      let entries: string[] = [];
      try { entries = await readdir(directory); } catch { /* No directory yet. */ }
      for (const entry of entries) {
        const match = pattern.exec(entry);
        if (!match || match[1] !== key || Number(match[2]) === pid || alive(Number(match[2]))) continue;
        const target = name();
        try {
          await rename(join(directory, entry), target);
          values.push(await readFile(target, 'utf8'));
          taken.push(target);
        } catch { /* Another process adopted it first, or it is unreadable and stays for a later owner. */ }
      }
      return { values, done: () => { for (const file of taken) void unlink(file).catch(() => {}); } };
    },
  };
}

export function nodePlatform(): Platform {
  return {
    clock: realClock,
    environment: {
      info: () => ({ platform: 'node', osName: ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[platform()] ?? 'Other',
        osVersion: release().split('.')[0] ?? '', locale: Intl.DateTimeFormat().resolvedOptions().locale }),
      sessionId: () => randomUUID(),
      hashUser: async id => createHash('sha256').update(id, 'utf8').digest('hex'),
      gzip: body => new Promise<Uint8Array>((resolve, reject) => zip(body, (error, result) => error ? reject(error) : resolve(new Uint8Array(result)))),
      warn: message => console.warn(message),
    },
    storage(appKey, options) {
      // An explicit storagePath belongs to one process; the default directory is safe for several.
      if (options.storagePath) return fileStorage(options.storagePath);
      return instanceStorage(join(homedir(), '.mightys-pulse'), createHash('sha256').update(appKey, 'utf8').digest('hex'));
    },
    transport: (appKey, host) => fetchTransport(appKey, host, () => globalThis.fetch),
    onHidden() { /* Node callers await flush before exiting. No process handlers are installed. */ },
  };
}
