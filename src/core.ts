import { defaults, identity } from './config.js';
import { batchFrom, restoreBatches, saveState } from './batch.js';
import type { Batch } from './batch.js';
import { ALL_ON, parseRemote } from './remote.js';
import { ServerPolicy } from './server-policy.js';
import { beginSession, parseUsage, usageFields } from './usage.js';
import type { Usage } from './usage.js';
import { DAY, normalize, size, validStored, wellFormed } from './validation.js';
import type { Platform, PulseClient, PulseOptions, Signal, Storage, SystemInfo, TrackOptions, Transport } from './types.js';

type Draft = Pick<Signal, 'timestamp' | 'sessionId' | 'type' | 'props' | 'value' | 'userHash'>;

// Debug warnings are few and generic: they never contain submitted data, and short texts keep the bundle small.
const STORAGE = 'Storage unavailable.';
const MISSING = 'Feature unavailable.';
const DISCARDED = 'Invalid data discarded.';
const FAILED = 'Operation failed.';

/**
 * Reads an opt-out flag. Unreadable text fails closed. A strict consent record must say optOut false to allow
 * collection; a queue envelope without the field (or no record at all) allows it.
 */
export function optedOut(text: string | null, strict = false): boolean {
  try {
    const value = (JSON.parse(text ?? 'null') as { optOut?: unknown } | null)?.optOut;
    return value === undefined ? strict && text !== null : value !== false;
  } catch { return true; }
}

/** The core uses injected capabilities only; importing it has no platform side effects. */
export function createPulse(platform: Platform): PulseClient {
  const { clock, environment: env } = platform;
  const policy = new ServerPolicy();
  const busy = new Set<Batch>();
  let options = { ...defaults };
  let initialized = false;
  let hydrated = false;
  let disabled = false;
  let explicitConsent: boolean | undefined;
  let stopped = false;
  let noGzip = false;
  let queue: Signal[] = [];
  let stored: Signal[] = [];
  let pending: Draft[] = [];
  let work: Batch[] = [];
  let storage: Storage | undefined;
  let transport: Transport | undefined;
  let ready = Promise.resolve();
  let writes = Promise.resolve();
  let consentWrites = Promise.resolve();
  let dirty = false;
  let writing = false;
  let running: Promise<void> | undefined;
  let lifecycle = false;
  let hiding: Promise<void> | undefined;
  let timer: unknown;
  let nextSend = 0;
  let retryAt = 0;
  let failures = 0;
  let session = '';
  let lastActivity = -Infinity;
  let userHash: string | undefined;
  let userGeneration = 0;
  let installHash: string | undefined;
  let installGeneration = 0;
  let installing = 0;
  let installOps = Promise.resolve();
  let fresh = false;
  let usage: Usage | undefined;
  let usageLoaded = false;
  let usageOps = Promise.resolve();
  let usageSaved = 0;
  let usageText = '';
  let sessionStart = 0;
  let starts: [number, string][] = [];
  let lastScreen = '';
  let remote = ALL_ON;

  const warn = (message: string): void => {
    try { if (options.debug) env.warn(message); } catch { /* Logging cannot affect the application. */ }
  };
  const protect = (action: () => void): void => {
    try { action(); } catch { warn(FAILED); }
  };
  // A signal type the portal has not switched off; automatic signals also need the portal's automatic switch.
  const allowed = (type: string): boolean => remote.automatic && !remote.off.includes(type);
  const interval = (): number => (policy.intervalSeconds ?? options.flushIntervalSeconds) * 1000;
  const drop = (signals: Signal[]): void => { queue = queue.filter(s => !signals.includes(s)); };
  // Queue records carry the opt-out flag too, for storages without a separate consent record.
  const envelope = (state?: object): string => JSON.stringify({ version: 1, optOut: disabled, ...state });

  function save(): Promise<void> {
    if (!storage || !hydrated) return writes;
    dirty = true;
    if (!writing) {
      writing = true;
      writes = writes.then(async () => {
        try {
          while (dirty) {
            dirty = false;
            const snapshot = queue.slice();
            try {
              if (await storage?.write(envelope(saveState(work, queue))) === false) {
                // Another instance adopted the last stored record and owns its delivery; newer signals stay here.
                drop(stored);
                work = [];
                dirty = true;
              } else stored = snapshot;
            } catch { warn(STORAGE); }
          }
        } finally { writing = false; }
      });
    }
    return writes;
  }

  function persistConsent(): void {
    const record = envelope();
    // Independent of queue writes, so a full queue store never blocks this tiny record.
    consentWrites = consentWrites.then(() => storage?.consent?.write(record)).catch(() => warn(STORAGE));
  }

  function prune(): void {
    const now = clock.now();
    const kept = queue.filter(s => {
      const time = Date.parse(s.timestamp);
      return time >= now - options.maxQueueAgeDays * DAY && time <= now + 3600000;
    }).slice(-options.maxQueueSize);
    // A removed signal takes only its batch's prepared bytes along; the batch's other signals stay queued.
    if (kept.length < queue.length) work = work.filter(b => b.signals.every(s => kept.includes(s)));
    queue = kept;
  }

  function schedule(): void {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    if (!hydrated || disabled || stopped || !queue.length || running) return;
    const due = Math.max(policy.pauseUntil, retryAt || (queue.length >= options.maxBatchSize ? clock.now() : nextSend));
    // Every delay is at most about one hour (interval, pause and Retry-After are capped), far below timer limits.
    timer = clock.setTimeout(() => { timer = undefined; void flush(); }, due - clock.now());
  }

  // Capture timestamps are strictly increasing at millisecond resolution: the later of the clock reading and the previous
  // timestamp plus one millisecond. Signals are materialized in queue order, automatic ones first.
  let lastStamp = -Infinity;
  function stamp(reading: number): string {
    lastStamp = Math.max(reading, lastStamp + 1);
    return new Date(lastStamp).toISOString();
  }

  function materialize(draft: Draft): Signal {
    let info = {} as SystemInfo;
    try { info = env.info(); } catch { warn(MISSING); }
    const clean = (v: string): string => typeof v === 'string' ? v.slice(0, 512) : '';
    const hash = draft.userHash ?? installHash;
    const reading = Date.parse(draft.timestamp);
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(info)) if (typeof value === 'string' && value) extra[key] = value.slice(0, 64);
    // Statistics, app name and build exist only where something is stored for the app (Node, native app wrappers).
    const full = storage?.usage ? {
      ...(usage ? usageFields(usage, reading, sessionStart) : {}),
      ...(options.appBuildNumber ? { appBuildNumber: options.appBuildNumber } : {}),
      ...(options.appName ? { appName: options.appName } : {}),
    } : {};
    // Fields of a group the portal switched off are left out; the base keys below never are.
    Object.assign(extra, full);
    remote.hidden.forEach(key => { delete extra[key]; });
    return {
      ...draft,
      timestamp: stamp(reading),
      ...(hash === undefined ? {} : { userHash: hash }),
      debug: options.debug,
      system: {
        ...extra,
        platform: clean(info.platform), osName: clean(info.osName), osVersion: clean(info.osVersion),
        locale: clean(info.locale), appVersion: options.appVersion,
        ...(info.deviceModel ? { deviceModel: clean(info.deviceModel) } : {}),
        sdkName: identity.sdkName, sdkVersion: identity.version,
      },
    };
  }

  /** Turns drafts into queued signals. Screen views are judged here, once the cached settings are known, never at capture time. */
  function admit(drafts: Draft[]): Signal[] {
    return drafts.filter(d => d.type !== 'pulse.screen_view' || allowed(d.type)).map(materialize);
  }

  function track(type: string, input?: TrackOptions): void {
    protect(() => {
      if (disabled) return;
      const fields = normalize(type, input, () => warn(DISCARDED));
      if (!fields) { warn(DISCARDED); return; }
      const now = clock.now();
      const begins = !session || now - lastActivity >= 1800000;
      if (begins) session = env.sessionId();
      lastActivity = now;
      // Session statistics wait for the stored record; sessions begun before it is read start in order afterwards.
      let first: Draft[] = [];
      if (begins && usageLoaded) first = startSession(now, session);
      else if (begins && (!hydrated || installing)) starts.push([now, session]);
      if (usageLoaded && usage && !begins) {
        usage = { ...usage, cur: [usage.cur?.[0] ?? now, now] };
        if (now - usageSaved > 15000) saveUsage();
      }
      add(...first, {
        ...fields, timestamp: new Date(now).toISOString(), sessionId: session,
        ...(userHash === undefined ? {} : { userHash }),
      });
    });
  }

  function add(...drafts: Draft[]): void {
    if (!hydrated || installing) {
      pending.push(...drafts);
      pending = pending.slice(-(initialized ? options.maxQueueSize : 100));
    } else {
      queue.push(...admit(drafts));
      prune();
      void save();
      schedule();
    }
  }

  async function loadRemote(): Promise<void> {
    remote = parseRemote(await storage?.config?.read().catch(() => null)) ?? ALL_ON;
  }

  /** Asks the portal for its settings once per launch. They apply from the next launch where storage exists, at once in a normal browser. */
  async function refresh(): Promise<void> {
    if (disabled || !transport?.config) return;
    try {
      const response = await transport.config(remote.version);
      const parsed = parseRemote(response.body);
      if (parsed && !disabled) { if (storage?.config) await storage.config.write(response.body!); else remote = parsed; }
    } catch { /* The cache or the all-on default stays. */ }
  }

  /** Registers a new session and returns the automatic signals that belong to its start. */
  function startSession(now: number, id: string): Draft[] {
    // The stored version moves on only when pulse.app_updated is queued, so an event that is switched off is sent once it is allowed.
    const keep = usage && !(options.automaticSignals && allowed('pulse.app_updated'));
    const next = beginSession(usage, now, keep ? usage!.ver : options.appVersion, keep ? usage!.build : options.appBuildNumber);
    usage = next.usage;
    sessionStart = now;
    const make = (type: string, props: Draft['props'] = {}): Draft => ({
      type, props, timestamp: new Date(now).toISOString(), sessionId: id, ...(userHash === undefined ? {} : { userHash }),
    });
    const out = [...fresh ? [make('pulse.new_install')] : [], ...next.changed ? [make('pulse.app_updated', { previousVersion: next.changed[0], previousBuild: next.changed[1] })] : [], make('pulse.session_started')]
      .filter(d => options.automaticSignals && allowed(d.type));
    saveUsage();
    fresh = false;
    return out;
  }

  /** Writes the statistics file one write after another. A failure keeps the in-memory statistics. */
  function saveUsage(): void {
    const record = usage;
    usageSaved = clock.now();
    if (!record || disabled) return;
    const text = JSON.stringify(record);
    if (text === usageText) return;
    usageText = text;
    usageOps = usageOps.then(() => storage?.usage?.write(text)).catch(() => warn(STORAGE));
  }

  async function loadUsage(): Promise<void> {
    const store = storage?.usage;
    if (!store) return;
    usage = undefined;
    try { usage = parseUsage(await store.read()); } catch { warn(STORAGE); }
    usageLoaded = true;
  }

  function removeUsage(): Promise<void> {
    usage = undefined;
    usageLoaded = false;
    usageText = '';
    starts = [];
    // The cached settings go with the statistics.
    usageOps = usageOps.then(() => Promise.allSettled([storage?.usage?.remove(), storage?.config?.remove()])).then(results => { if (results.some(r => r.status === 'rejected')) warn(STORAGE); });
    return usageOps;
  }

  /** A new batch id, 32 lowercase hex characters; none (the header is left out) where no secure generator exists. */
  function batchId(): string | undefined {
    try { return env.installId(); } catch { warn(MISSING); }
  }

  /** Starts a new batch from queued signals that no prepared batch holds yet. */
  function selectBatch(limit: number): Batch | undefined {
    const selected: Signal[] = [];
    let bytes = 2;
    for (const signal of queue.filter(s => !work.some(b => b.signals.includes(s))).slice(0, options.maxBatchSize)) {
      const length = size(JSON.stringify(signal)) + (selected.length ? 1 : 0);
      if (bytes + length > limit) break;
      selected.push(signal);
      bytes += length;
    }
    if (!selected.length) return;
    const batch = batchFrom(selected, batchId());
    work.push(batch);
    return batch;
  }

  function discard(batch: Batch): void {
    drop(batch.signals);
    work = work.filter(item => item !== batch);
    failures = 0;
  }

  /** Halves keep splitting on later rejections, isolating single bad signals in about 2*log2(n) extra requests. */
  function split(batch: Batch): void {
    const half = Math.ceil(batch.signals.length / 2);
    work.splice(work.indexOf(batch), 1, batchFrom(batch.signals.slice(0, half), batchId()), batchFrom(batch.signals.slice(half), batchId()));
  }

  async function drain(keepalive: boolean): Promise<void> {
    if (!hydrated || disabled || stopped || !transport) return;
    prune();
    await save();
    while (queue.length && !disabled && !stopped) {
      if (clock.now() < Math.max(retryAt, policy.pauseUntil)) break;
      // A lifecycle send may run beside a normal send; each batch is in flight at most once.
      const batch = work.find(b => !busy.has(b)) ?? selectBatch(keepalive ? 65536 : 1048576);
      if (!batch) break;
      busy.add(batch);
      try {
        if (!batch.body) {
          if (!keepalive && options.gzip && !noGzip && batch.bytes.byteLength > 1024) {
            try { batch.body = await env.gzip(batch.bytes); batch.gzip = batch.body !== undefined; }
            catch { warn(MISSING); }
          }
          batch.body ??= batch.bytes;
        }
        if (keepalive && batch.body.byteLength > 65536) break;
        await save();
        if (disabled || stopped) break;
        const response = await transport.send(batch.body, batch.gzip, keepalive, batch.id);
        if (disabled) break;
        policy.apply(response.body, clock.now(), options.flushIntervalSeconds);
        const status = response.status;
        const ok = status > 199 && status < 300;
        if (!work.includes(batch)) {
          // Eviction or adoption detached this batch while in flight; delivered survivors leave the queue.
          if (ok) drop(batch.signals);
        } else if (ok) {
          discard(batch);
          retryAt = 0;
        } else if (status === 401) {
          stopped = true;
          warn('Stopped: invalid app key.');
        } else if ((status === 415 || status === 413) && batch.gzip) {
          // 415 disables gzip until reload. A 413 may be the gzip expansion limit: resend these bytes uncompressed first.
          if (status === 415) noGzip = true;
          for (const item of status === 415 ? work : [batch]) { item.body = item.bytes; item.gzip = false; }
          if (!keepalive) continue;
        } else if (status === 400 || status === 413) {
          if (batch.signals.length > 1) {
            split(batch);
            if (!keepalive) continue;
          } else {
            discard(batch);
            warn(DISCARDED);
          }
        } else {
          // 408, 425, 429, 5xx and any other status keep the batch. Repeated body-read timeouts shrink it.
          if (status === 408 && batch.timeouts++ && batch.signals.length > 1) split(batch);
          backoff(response.retryAfter);
        }
      } catch { if (!disabled) backoff(); } finally { busy.delete(batch); }
      await save();
      if (keepalive) break;
    }
  }

  function backoff(header?: string | null): void {
    const now = clock.now();
    // Retry-After in seconds or as an HTTP date, honored up to one hour. Absent means no extra delay.
    const seconds = Number(header ?? 0);
    const after = Math.min(Number.isNaN(seconds) ? Date.parse(header!) : now + seconds * 1000, now + 3600000);
    const jitter = Math.min(300000, 1000 * 2 ** Math.min(failures++, 9) * (1 + clock.random()));
    retryAt = Math.max(now + jitter, after || 0, now + (policy.intervalSeconds ?? 0) * 1000);
  }

  function flush(keepalive = false): Promise<void> {
    if (!initialized) return Promise.resolve();
    saveUsage();
    if (running) {
      // Page hide gets one keepalive attempt even while a normal send is in flight.
      if (keepalive && !lifecycle && !hiding) {
        hiding = drain(true).catch(() => warn(FAILED)).finally(() => { hiding = undefined; });
      }
      return running;
    }
    lifecycle = keepalive;
    running = ready.then(() => installOps).then(() => drain(keepalive)).catch(() => warn(FAILED)).finally(() => {
      running = undefined;
      nextSend = policy.pauseUntil > clock.now() ? policy.pauseUntil : clock.now() + interval();
      protect(schedule);
    });
    return running;
  }

  /** Install id changes run one after another, so a removal is complete before a new id is read. */
  function serial(action: () => Promise<void>): Promise<void> {
    const run = installOps.then(action);
    installOps = run.catch(() => {});
    return run;
  }

  /** Reads or creates the install id and keeps its hash. Never throws; an unusable store gives an in-memory id. */
  function loadInstall(): Promise<void> {
    const generation = ++installGeneration;
    return serial(async () => {
      const store = storage?.install;
      if (!store) return;
      const valid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
      try {
        let failed = false;
        let id = await store.read().catch(() => { failed = true; warn(STORAGE); return null; });
        if (!valid(id)) {
          id = env.installId();
          const kept = await store.write(id).catch(() => { failed = true; warn(STORAGE); });
          // A store that returns another id lost the race to another process, which reports the new install; one that returns ours (or nothing) created it here.
          if (valid(kept) && kept !== id) id = kept; else fresh ||= !failed;
        }
        const hash = await env.hashUser(id);
        if (generation === installGeneration && !disabled && /^[a-f0-9]{64}$/.test(hash)) installHash = hash;
      } catch { warn(MISSING); }
    });
  }

  function removeInstall(): Promise<void> {
    installHash = undefined;
    ++installGeneration;
    return serial(async () => { try { await storage?.install?.remove(); } catch { warn(STORAGE); } });
  }

  function installHook(): void {
    if (options.automaticScreenViews && allowed('pulse.screen_view')) protect(() => platform.screens?.(screen));
  }

  function init(appKey: string, input: PulseOptions = {}): void {
    protect(() => {
      if (initialized || typeof appKey !== 'string' || !appKey.trim() || /[\r\n]/.test(appKey)) return;
      const numeric = (name: 'flushIntervalSeconds' | 'maxBatchSize' | 'maxQueueSize' | 'maxQueueAgeDays', min: number, max: number, integer?: boolean): number => {
        const v = input[name]!;
        return Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)) ? v : defaults[name];
      };
      const host = new URL(input.host ?? defaults.host);
      if (!/^https?:$/.test(host.protocol) || host.username || host.password || host.search || host.hash) return;
      options = {
        host: host.href.replace(/\/$/, ''),
        flushIntervalSeconds: numeric('flushIntervalSeconds', 1, 3600),
        maxBatchSize: numeric('maxBatchSize', 1, 1000, true),
        maxQueueSize: numeric('maxQueueSize', 1, 100000, true),
        // The server rejects signals older than 30 days; one day of margin covers clock skew.
        maxQueueAgeDays: Math.min(29, numeric('maxQueueAgeDays', 1 / 86400, 30)),
        gzip: input.gzip !== false,
        automaticScreenViews: input.automaticScreenViews !== false,
        automaticSignals: input.automaticSignals !== false,
        debug: typeof input.debug === 'boolean' ? input.debug : platform.development(),
        appVersion: typeof input.appVersion === 'string' ? wellFormed(input.appVersion.slice(0, 512)) : '',
        appBuildNumber: typeof input.appBuildNumber === 'string' ? wellFormed(input.appBuildNumber.slice(0, 64)) : '',
        appName: typeof input.appName === 'string' ? wellFormed(input.appName.slice(0, 64)) : '',
      };
      const store = storage = platform.storage(appKey, input);
      transport = platform.transport(appKey, options.host);
      initialized = true;
      nextSend = clock.now() + interval();
      ready = (async () => {
        let consent: string | null = null;
        let claimed: { values: string[]; done(): void } | undefined;
        const records: (string | null)[] = [];
        try {
          const own = store.read();
          // A consent store that fails to read may hold an opt-out: fail closed.
          try { consent = await store.consent?.read() ?? null; } catch { consent = '?'; }
          records.push(await own);
          claimed = await store.claim?.();
          records.push(...claimed?.values ?? []);
        } catch { warn(STORAGE); }
        let out = false;
        for (const record of records) {
          out ||= optedOut(record);
          try {
            const state = JSON.parse(record ?? 'null') as { version?: unknown; queue?: unknown; batches?: unknown } | null;
            if (state?.version === 1) {
              const loaded = (state.queue as unknown[]).map(s => validStored(s, clock.now(), options.maxQueueAgeDays) ? s : undefined);
              work.push(...restoreBatches(state.batches, loaded, batchId));
              queue.push(...loaded.filter((s): s is Signal => !!s));
            }
          } catch { warn(STORAGE); }
        }
        disabled = explicitConsent ?? (store.consent ? optedOut(consent, true) : out);
        if (disabled) { await removeInstall(); await removeUsage(); } else { await loadRemote(); await loadInstall(); await loadUsage(); }
        hydrated = true;
        if (disabled) { pending = []; queue = []; work = []; userHash = undefined; ++userGeneration; }
        else {
          const began = starts.splice(0).flatMap(([at, id]) => usageLoaded ? startSession(at, id) : []);
          queue = queue.concat(admit([...began, ...pending]));
        }
        pending = [];
        // Where settings are stored they are read first; the hook is installed only if they allow screen views.
        if (store.config) installHook();
        // Writes only a change made here before loading; a change that arrived from another instance is already stored.
        if (disabled !== optedOut(consent, true)) persistConsent();
        prune();
        await save();
        protect(() => claimed?.done());
        schedule();
        void refresh();
      })().catch(() => warn(FAILED));
      // Opt-out in another tab applies here at once; only an explicit optOut(false) enables collection again.
      protect(() => store.watch?.(record => { if (record !== null) protect(() => consent(optedOut(record, true), false)); }));
      protect(() => platform.onHidden(() => { void flush(true); }));
      if (!store.config) installHook();
    });
  }

  async function setUser(id: string | null): Promise<void> {
    const generation = ++userGeneration;
    try {
      userHash = undefined;
      if (disabled || !id || typeof id !== 'string') return;
      const hash = await env.hashUser(id);
      if (generation === userGeneration && !disabled && /^[a-f0-9]{64}$/.test(hash)) userHash = hash;
    } catch { warn(MISSING); }
  }

  function consent(value: boolean, persist: boolean): void {
    explicitConsent = disabled = value;
    if (value) {
      userHash = undefined;
      ++userGeneration;
      pending = []; queue = []; work = [];
      protect(() => transport?.cancel());
      void removeInstall();
      void removeUsage();
    } else if (hydrated && storage?.install && installHash === undefined) {
      // A new id is created now; signals tracked meanwhile wait so that they carry its hash.
      installing++;
      if (storage.usage) session = '';
      void loadInstall().then(loadUsage).finally(() => {
        protect(() => {
          if (--installing) return;
          if (!disabled) queue.push(...admit([...starts.splice(0).flatMap(([at, id]) => usageLoaded ? startSession(at, id) : []), ...pending]));
          pending = [];
          prune();
          void save();
          schedule();
        });
      });
    }
    if (persist && hydrated) persistConsent();
    void save();
    schedule();
  }

  function optOut(value: boolean): void {
    protect(() => { if (typeof value === 'boolean') consent(value, true); });
  }

  function screen(name: string): void {
    protect(() => {
      if (disabled || typeof name !== 'string') return;
      const clean = wellFormed(name).slice(0, 128);
      // The same screen again, with no other screen in between, is not a new appearance.
      if (!clean.trim() || clean === lastScreen) return;
      const previous = lastScreen;
      lastScreen = clean;
      track('pulse.screen_view', { props: { screen: clean, ...(previous ? { previousScreen: previous } : {}) } });
    });
  }

  return { init, track, setUser, flush: () => flush(), optOut, screen };
}
