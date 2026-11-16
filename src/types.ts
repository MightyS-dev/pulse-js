export interface PulseOptions {
  host?: string;
  flushIntervalSeconds?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  maxQueueAgeDays?: number;
  gzip?: boolean;
  /**
   * Browser and native app wrappers: sends `pulse.screen_view` when the route changes (History API, `popstate`,
   * `hashchange` and the first page). Default true. When false nothing is patched or listened to. Node never does it
   * on its own; call `screen(name)`.
   */
  automaticScreenViews?: boolean;
  /**
   * Node and native app wrappers: sends `pulse.session_started`, `pulse.new_install` and `pulse.app_updated`. Default
   * true. The portal can switch these off too; this option can only switch them off, never force them on.
   */
  automaticSignals?: boolean;
  /**
   * Marks signals as test data and enables warnings. An explicit value always wins. When omitted, signals are marked
   * as test data only in a development build: in Node when `NODE_ENV` is `development` or `test` at `init`, in the
   * browser when the bundler replaced `process.env.NODE_ENV` with one of those values. Otherwise they count as real data.
   */
  debug?: boolean;
  appVersion?: string;
  /** Node and native app wrappers only: the build number of your app. Sent as `appBuildNumber`. */
  appBuildNumber?: string;
  /** Node and native app wrappers only: the name of your app. Sent as `appName`. */
  appName?: string;
  /**
   * Node only. A queue file used by exactly one process, with consent in `<storagePath>.consent`. The default
   * directory needs no option and is safe for several processes.
   */
  storagePath?: string;
}

export interface TrackOptions {
  value?: number | null;
  props?: Record<string, string | number | boolean>;
}

export interface PulseClient {
  init(appKey: string, options?: PulseOptions): void;
  track(type: string, options?: TrackOptions): void;
  setUser(id: string | null): Promise<void>;
  flush(): Promise<void>;
  optOut(disabled: boolean): void;
  /** Sends `pulse.screen_view` for a screen name (at most 128 characters). Repeating the same name is ignored. */
  screen(name: string): void;
}

export interface SystemInfo {
  platform: string;
  osName: string;
  osVersion: string;
  locale: string;
  /** Only where the platform gives it without fingerprinting. */
  deviceModel?: string;
  /** Further string fields (architecture, screen, settings and so on); a field the platform cannot give is left out. */
  [key: string]: string | undefined;
}

export interface Signal {
  timestamp: string;
  sessionId: string;
  userHash?: string;
  type: string;
  value?: number | null;
  debug: boolean;
  system: SystemInfo & { appVersion: string; sdkName: string; sdkVersion: string };
  props: Record<string, string | number>;
}

export interface Clock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Storage {
  /** This instance's own queue record. */
  read(): Promise<string | null>;
  /** Resolves false when another instance adopted this record; the caller then drops its copy. */
  write(value: string): Promise<boolean | void>;
  /** Shared consent record, kept apart from per-instance queues. */
  consent?: { read(): Promise<string | null>; write(value: string): Promise<void> };
  /** Queue records left by closed instances. Call done() once they are adopted; they are then removed. */
  claim?(): Promise<{ values: string[]; done(): void }>;
  /** Present only where storage belongs to the app (Node, native app wrappers); a normal browser has none. */
  install?: InstallStore;
  /** Session statistics, kept next to the install id under the same rule. */
  usage?: { read(): Promise<string | null>; write(value: string): Promise<void>; remove(): Promise<void> };
  /** The last settings from the portal, kept under the same rule as the install id. */
  config?: { read(): Promise<string | null>; write(value: string): Promise<void>; remove(): Promise<void> };
  /** Consent records written by other instances. */
  watch?(callback: (consent: string | null) => void): void;
}

/** The anonymous install id: 32 lowercase hex characters, kept only in storage that belongs to the app. */
export interface InstallStore {
  read(): Promise<string | null>;
  /** Returns the id that is stored afterwards, which differs when another process created one first. */
  write(id: string): Promise<string | void>;
  remove(): Promise<void>;
}

export interface TransportResponse {
  status: number;
  body?: string;
  retryAfter?: string | null;
}

export interface Transport {
  send(body: Uint8Array, gzip: boolean, keepalive: boolean): Promise<TransportResponse>;
  cancel(): void;
  /** Reads the settings from the portal; `version` is the cached one, sent as `If-None-Match`. */
  config?(version?: number): Promise<TransportResponse>;
}

export interface Environment {
  info(): SystemInfo;
  sessionId(): string;
  /** 16 secure random bytes as 32 lowercase hex characters; throws when no secure generator exists. */
  installId(): string;
  hashUser(id: string): Promise<string>;
  gzip(body: Uint8Array): Promise<Uint8Array | undefined>;
  warn(message: string): void;
}

export interface Platform {
  clock: Clock;
  environment: Environment;
  storage(appKey: string, options: PulseOptions): Storage;
  transport(appKey: string, host: string): Transport;
  /** True only with positive evidence of a development build. Read once, at init. */
  development(): boolean;
  onHidden(callback: () => void): void;
  /** Calls back with a screen name on the first page and on every route change; absent where there is no routing. */
  screens?(callback: (name: string) => void): void;
}
