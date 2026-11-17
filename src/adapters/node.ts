import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { gzip as zip } from 'node:zlib';
import { fetchTransport, realClock, resilientStorage } from './shared.js';
import type { InstallStore, Platform, Storage, SystemInfo } from '../types.js';

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

const INSTALL_ID = /^[a-f0-9]{32}$/;

/** The install id file. Creation is atomic, so processes of one app that start together end up with one id. */
function installFile(path: string): InstallStore {
  return {
    read: async () => (await readText(path))?.trim() ?? null,
    async write(id) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeText(temporary, id);
        try { await link(temporary, path); return id; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const stored = (await readText(path))?.trim();
          if (stored && INSTALL_ID.test(stored)) return stored;
          await rename(temporary, path);
          return id;
        }
      } finally { await unlink(temporary).catch(() => {}); }
    },
    remove: () => unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }),
  };
}

/** A queue file plus a consent file. A consent file that exists but cannot be read is treated as opted out. */
export function fileStorage(path: string, consentPath = `${path}.consent`, installPath = `${path}.install-id`, usagePath = `${path}.usage`, configPath = `${path}.config`,
  controlPath = `${path}.control`, localPath = `${path}.control-local`): Storage {
  return resilientStorage({
    install: installFile(installPath),
    usage: { read: () => readText(usagePath), write: value => writeText(usagePath, value),
      remove: () => unlink(usagePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }) },
    config: { read: () => readText(configPath), write: value => writeText(configPath, value),
      remove: () => unlink(configPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }) },
    // The last App Control answer and what it remembers: two small files next to the install id. Nothing is ever removed with the analytics data.
    control: () => ({ cache: { read: () => readText(controlPath), write: value => writeText(controlPath, value) }, local: { read: () => readText(localPath), write: value => writeText(localPath, value) } }),
    read: () => readText(path),
    write: value => writeText(path, value),
    flushSync(value, early) {
      const temporary = `${path}.${process.pid}.sync.tmp`;
      if (early) {
        // The file may hold signals from an earlier run that this one has not read: keep them, and write nothing over an opt-out.
        let old: { optOut?: unknown; queue?: unknown; batches?: unknown } | undefined;
        try { old = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
        if (old) {
          if (old.optOut !== undefined && old.optOut !== false || !Array.isArray(old.queue)) return;
          const mine = JSON.parse(value) as { queue: unknown[] };
          value = JSON.stringify({ ...mine, queue: [...old.queue, ...mine.queue], batches: old.batches ?? [] });
        }
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, path);
    },
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
    ...fileStorage(name(), join(directory, `${key}.json`), join(directory, `install-id-${key.slice(0, 16)}`), join(directory, `usage-${key.slice(0, 16)}`), join(directory, `config-${key.slice(0, 16)}`),
      join(directory, `control-${key.slice(0, 16)}`), join(directory, `control-local-${key.slice(0, 16)}`)),
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

/** The OS version. Node reports the Darwin kernel on macOS; it maps to the macOS major version, or to nothing when unknown. */
export function osVersionOf(os: string, kernel: string): string {
  if (os !== 'darwin') return /^\d+(\.\d+){0,2}/.exec(kernel)?.[0] ?? '';
  const major = Number(kernel.split('.')[0]);
  // Darwin 20 to 24 are macOS 11 to 15; from Darwin 25 on the macOS major version is one higher.
  return major >= 25 ? String(major + 1) : major >= 20 ? String(major - 9) : '';
}

export function nodeInfo(): SystemInfo {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const architecture = ({ x64: 'x86_64', arm64: 'arm64', arm: 'armv7' } as Record<string, string>)[process.arch];
  let region: string | undefined;
  try { region = new Intl.Locale(locale).region; } catch { /* No region in this locale. */ }
  const language = locale.split('-')[0] ?? '';
  return {
    platform: 'node', osName: ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[platform()] ?? 'Other',
    osVersion: osVersionOf(platform(), release()), locale, deviceType: 'desktop', runtimeVersion: `Node ${process.versions.node}`,
    isDebugBuild: String(['development', 'test'].includes(process.env.NODE_ENV ?? '')),
    utcOffsetMinutes: String(-new Date().getTimezoneOffset() || 0),
    ...(architecture ? { architecture } : {}), ...(zone ? { timeZone: zone } : {}),
    ...(language ? { language, preferredLanguage: language } : {}), ...(region ? { region } : {}),
  };
}

export function nodePlatform(): Platform {
  return {
    clock: realClock,
    environment: {
      info: nodeInfo,
      sessionId: () => randomUUID(),
      installId: () => randomBytes(16).toString('hex'),
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
    development: () => ['development', 'test'].includes(process.env.NODE_ENV ?? ''),
    onHidden() { /* Node callers await flush before exiting. */ },
    launch: () => process.uptime() * 1000,
    // 'uncaughtExceptionMonitor' observes a fatal error before Node decides what to do with it and changes nothing:
    // listeners of the app still run, and without one Node prints the error and exits with its usual code. The queue is
    // written synchronously, so a dying process loses nothing and the crash is sent at the next start. No
    // 'uncaughtException' listener is added, because that would turn a crash into a survived error. A rejection that Node
    // turns into an uncaught exception arrives here with origin 'unhandledRejection' (kind error). A 'unhandledRejection'
    // listener is added only when the app already has one, which keeps Node's handling of rejections as it is.
    errors(report) {
      process.on('uncaughtExceptionMonitor', (error, origin) => report(origin === 'unhandledRejection' ? 'error' : 'crash', error, true));
      if (process.listenerCount('unhandledRejection')) process.on('unhandledRejection', reason => report('error', reason));
    },
  };
}
