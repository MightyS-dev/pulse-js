import type { ControlApi, ControlEngine, ControlHost, ControlState, Platform, Storage, Transport } from './types.js';

type Saved = { at: number; rules: Record<string, any> };

/** Rules that ask for something. Rules that ask for nothing never load the control module. */
const active = (r: Record<string, unknown>): boolean => [r.update, r.blocked, r.maintenance, r.announcement, r.whatsNew]
  .some(v => v && (typeof v !== 'object' || Object.keys(v).length));

/**
 * The part of App Control that is always in the bundle: the control id, one request with its cache, and the question
 * whether there is anything to decide. The decision, the texts and the screens live in the control module, which
 * `import()` loads only when the rules ask for something. Every failure keeps the last known state or `normal`.
 */
export function createControl(platform: Platform): {
  api: ControlApi;
  start(key: string, mode: string | undefined, options: ControlHost['options'], storage: Storage, transport: Transport): void;
  foreground(): void;
} {
  const shared: ControlHost['shared'] = { state: { kind: 'normal', allowContinue: true, isTestBuild: false } as ControlState, listeners: new Set() };
  let engine: Promise<ControlEngine | undefined> | undefined;
  let first = Promise.resolve();
  // Before `start` (and with App Control off) a check has nothing to do.
  let check = (_force?: boolean): Promise<void> => first;
  const act = (name: 'openStore' | 'dismiss' | 'foreground'): void => { void engine?.then(e => e?.[name]()); };

  return {
    api: {
      get: () => first.then(() => shared.state),
      subscribe: listener => { shared.listeners.add(listener); return () => { shared.listeners.delete(listener); }; },
      checkNow: () => check(true),
      openStore: () => act('openStore'),
      dismiss: () => act('dismiss'),
    },
    foreground() {
      act('foreground');
      void check();
    },
    start(key, mode, options, storage, transport) {
      if (mode === 'off' || !transport.control) return;
      const { clock, environment } = platform;
      let items: ReturnType<NonNullable<Storage['control']>> | undefined;
      let saved: Saved | undefined;
      let last = -Infinity;
      let flight: Promise<void> | undefined;
      let pending: Promise<unknown> | undefined;
      /** False when the answer is not usable. Empty rules need no module, unless it is loaded and must clear a screen. */
      const accept = async (rules: Record<string, unknown> | undefined, at: number, fresh: boolean): Promise<boolean> =>
        rules?.format === 1 && (!(engine || active(rules)) || ((await (engine ??= import('./control/index.js')
          .then(m => m.attach(shared, mode, options, environment, clock, platform.wrapped?.() === true, items?.local, () => check(true)))
          .catch(() => engine = undefined)))?.apply(rules, at, fresh) ?? false));
      async function request(): Promise<void> {
        const id = (await environment.hashUser(key)).slice(0, 32);
        if (!items) {
          items = storage.control?.(id);
          try {
            saved = JSON.parse(await items!.cache.read() ?? '') as Saved;
            // Not awaited here: the answer of the cache must not delay the request. `check` waits for it at the end.
            pending = accept(saved.rules, saved.at, false).catch(() => {});
          } catch { /* No usable cache. */ }
        }
        const answer = await transport.control!(id, saved?.rules?.version);
        const at = clock.now();
        const rules = answer.status === 200 ? JSON.parse(answer.body!) : answer.status === 304 ? saved?.rules : undefined;
        if (await accept(rules, at, true)) {
          saved = { at, rules };
          await items?.cache.write(JSON.stringify(saved)).catch(() => {});
        }
      }
      check = force => {
        const now = clock.now();
        if (flight) return flight;
        if (!force && now >= last && now - last < 60000) return Promise.resolve();
        last = now;
        return flight = request().catch(() => {}).then(() => pending as Promise<void>).finally(() => { flight = undefined; });
      };
      first = check(true);
    },
  };
}
