import type { ErrorInfo } from './errors.js';

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
   * Browser and native app wrappers: by default nothing is sent from crawlers and automated browsers (`navigator.webdriver`
   * is true, or the user agent names a known crawler, headless browser or page-speed tool). Set true in a test harness
   * that drives a real browser. Default false.
   */
  allowAutomatedBrowsers?: boolean;
  /**
   * Browser, native app wrappers and Node.js: sends unhandled errors, rejections and crashes as `pulse.error` with the
   * error type, a filtered message and readable frames. Default true. When false nothing is installed;
   * `trackError` still works. See Errors and crashes in the README.
   */
  captureErrors?: boolean;
  /** `'full'` (default): type, filtered message and frames. `'typeOnly'`: only the kind and the type. */
  errorDetail?: 'full' | 'typeOnly';
  /**
   * Browser and native app wrappers: heatmaps of taps and clicks (`pulse.heatmap`: screen name, position and kind, never
   * text or inputs). Off until the portal switches them on for the app; this option can only switch them off. Default true
   * (follow the portal). Mark an element with `data-pulse-ignore` to keep its taps out.
   */
  captureHeatmaps?: boolean;
  /**
   * Marks signals as test data and enables warnings. An explicit value always wins. When omitted, signals are marked
   * as test data only in a development build: in Node when `NODE_ENV` is `development` or `test` at `init`, in the
   * browser when the bundler replaced `process.env.NODE_ENV` with one of those values. Otherwise they count as real data.
   */
  debug?: boolean;
  appVersion?: string;
  /**
   * App Control (the portal can require an update, suggest one or announce maintenance). `'automatic'` (default): checks after
   * `init` and shows the built-in screens in the browser and in app wrappers. `'manual'`: checks and keeps `Pulse.control` up to
   * date but shows nothing; draw your own screens. `'off'`: no request at all and the state is always `normal`.
   */
  control?: ControlMode;
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

export type ControlMode = 'automatic' | 'manual' | 'off';
export type ControlKind = 'normal' | 'updateSuggested' | 'updateRequired' | 'versionBlocked' | 'maintenance' | 'maintenanceUpcoming' | 'announcement' | 'whatsNew';

/** What the app should show right now. Read it with `Pulse.control.get()` or listen with `Pulse.control.subscribe`. */
export interface ControlState {
  kind: ControlKind;
  title?: string | undefined;
  /** Screen text, or the banner text for `maintenanceUpcoming`. */
  body?: string | undefined;
  /** Text of the main button (update, try again, OK), or undefined when the screen has none. */
  buttonText?: string | undefined;
  /** Text of the second button ("Not now" or "Continue"), or undefined when the user cannot leave the screen. */
  secondaryButtonText?: string | undefined;
  /** Where the main button goes: the store page, or the link of an announcement. */
  url?: string | undefined;
  /** Start and end of the maintenance window, ISO 8601 UTC. */
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  /** The version a card is about (what's new) or the version the update leads to. */
  version?: string | undefined;
  /** True when the user may leave the screen (`dismiss()` works). */
  allowContinue: boolean;
  /** True in a debug build: a locking screen then also shows a test banner and a Continue button. */
  isTestBuild: boolean;
  testBuildText?: string | undefined;
}

export interface ControlApi {
  /** The state once the first check has finished (at most 5 seconds); `normal` at once when App Control is off. Never rejects. */
  get(): Promise<ControlState>;
  /** Calls `listener` on every change of the state. Returns a function that stops it. */
  subscribe(listener: (state: ControlState) => void): () => void;
  /** Checks the rules now. Never rejects. */
  checkNow(): Promise<void>;
  /** Opens `state.url` (the store page) where there is one. */
  openStore(): void;
  /** Lets the user leave the current state where it allows that (a suggestion, a card, a screen with `allowContinue`). */
  dismiss(): void;
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
  /** Sends a handled error as `pulse.error` (kind `handled`). Works with `captureErrors: false`. At most 10 per session per type. */
  /**
   * Native app wrappers only: sends `pulse.deep_link` for a URL the app was opened with (scheme, host and path with ids as
   * `:id`, plus the three utm_ tags; never the query or fragment). Does nothing elsewhere.
   */
  deepLink(url: string): void;
  trackError(error: unknown, props?: Record<string, string | number | boolean>): void;
  /** App Control: the state the portal asks for (update, maintenance, announcement). Starts by itself after `init`. */
  control: ControlApi;
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
  error?: ErrorInfo;
  heatmap?: HeatmapInfo;
}

export interface HeatPoint { x: number; y: number; kind: 'tap' | 'rage' | 'dead' }
export interface HeatmapInfo { screen: string; bucket: string; orientation: string; points: HeatPoint[] }
/** A tap in logical px: `x` from the left of the viewport, `y` from the top of the page, with the viewport size. */
export interface HeatTap { x: number; y: number; width: number; height: number }

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
  /** Writes this instance's queue record before the call returns (a crashing Node process). `early`: the stored queue was not read yet, so keep it. */
  flushSync?(value: string, early?: boolean): void;
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
  /** Where App Control keeps its last answer and what it remembers on the device. `id` is the control id. */
  control?(id: string): { cache: ControlItem; local: ControlItem };
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

export interface ControlItem {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface TransportResponse {
  status: number;
  body?: string;
  retryAfter?: string | null;
}

export interface Transport {
  send(body: Uint8Array, gzip: boolean, keepalive: boolean, batch?: string): Promise<TransportResponse>;
  cancel(): void;
  /** Reads the settings from the portal; `version` is the cached one, sent as `If-None-Match`. */
  config?(version?: number): Promise<TransportResponse>;
  /** Reads the App Control rules. `version` is the cached one, sent as `If-None-Match`. Sends no identity; 3 seconds to the headers, 5 in all, at most 65536 bytes. */
  control?(id: string, version?: unknown): Promise<TransportResponse>;
}

/** What the core hands to the App Control module when it loads. */
export interface ControlHost {
  /** The `control` option as given. */
  mode: string | undefined;
  options: { appVersion: string; appName: string; debug: boolean };
  env: Environment;
  clock: Clock;
  /** The state and the listeners of `Pulse.control`, kept by the core so that they exist before the module loads. */
  shared: { state: ControlState; listeners: Set<(state: ControlState) => void> };
  /** Inside an app wrapper (Capacitor, Cordova, a web view). */
  app: boolean;
  /** What App Control remembers on the device; undefined where nothing can be stored. */
  local: ControlItem | undefined;
  /** Asks the core to check the rules now. */
  check(): Promise<void>;
}

/** The loaded App Control module. `apply` returns false when it did not accept the rules (they are then not cached). */
export interface ControlEngine {
  apply(rules: unknown, savedAt: number, fresh: boolean): boolean;
  foreground(): void;
  dismiss(): void;
  openStore(): void;
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
  /** True in a crawler or automated browser; absent where that cannot apply (Node). */
  automated?(): boolean;
  /**
   * Installs the error hooks without changing how the platform treats errors. `sync` asks to store the queue at once,
   * because the process may be about to end.
   */
  errors?(report: (kind: 'crash' | 'error', value: unknown, sync?: boolean) => void): void;
  /** Calls back with a screen name on the first page and on every route change; absent where there is no routing. */
  screens?(callback: (name: string) => void): void;
  /** Calls back when the page or app becomes visible (true) or hidden (false); returns whether it is visible now. */
  lifecycle?(callback: (visible: boolean) => void): boolean;
  /** True inside a native app wrapper, which unlocks the app signals, permissions and deep links. */
  wrapped?(): boolean;
  /** The highest scroll position (0 to 100) since the last call, which starts the next measurement. */
  scroll?(): number;
  /** The query of the landing page, read once at init. Only its utm_ tags are used. */
  campaign?(): { get(name: string): string | null } | undefined;
  /** The notification permission as granted, denied or notDetermined; a status read that never asks. */
  permission?(): string | undefined;
  /**
   * Browsers and app wrappers: watches taps. `ready` is asked first, so nothing else runs while heatmaps are off; `report`
   * gets a tap that passed the privacy rules and returns a function that marks it dead (web only), or nothing.
   */
  heatmap?(ready: () => boolean, report: (tap: HeatTap) => (() => void) | undefined): void;
  /** Browsers only: reads the one-time overlay token from the address bar (and removes it) and starts the overlay. */
  overlay?(host: string): void;
  /** Milliseconds from the start of the process or page to now; absent where unknown. */
  launch?(): number | undefined;
}
