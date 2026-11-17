# MightyS Pulse for JavaScript

Privacy-first analytics for web apps, browser games and Node.js. No cookies, no device IDs, offline queue, under 14 kB gzipped.

Docs: https://pulse.mightys.dev/docs/javascript/

MightyS Pulse lets a web app, a browser game or a Node.js service send named signals (events) with an optional number and a few properties, and see them in the Pulse dashboard. It sets no cookies, reads no advertising or device identifier and does no fingerprinting. It has zero runtime dependencies.

## Install

```sh
npm install @mightys-dev/pulse
# or: pnpm add @mightys-dev/pulse
# or: yarn add @mightys-dev/pulse
```

## Quick start

Browser. Bundlers that honour the `browser` condition resolve the default import to the web build; the `/web` entry selects it explicitly.

```ts
import { Pulse } from '@mightys-dev/pulse/web';

Pulse.init('YOUR_APP_KEY', { appVersion: '1.0.0' }); // your app key from the Pulse dashboard
Pulse.track('purchase', { value: 4.99, props: { sku: 'gems_100', discounted: false } });
await Pulse.flush(); // optional: sends what is eligible now
```

Node.js (ESM; for CommonJS use `const { Pulse } = require('@mightys-dev/pulse');`):

```js
import { Pulse } from '@mightys-dev/pulse';

Pulse.init(process.env.PULSE_APP_KEY, {
  appVersion: '1.0.0',
  storagePath: './.analytics/queue.json',
});
Pulse.track('job.complete', { value: 1, props: { job: 'daily-summary' } });
await Pulse.flush(); // Node installs no exit handler: flush before exiting
```

Nothing else is needed to count users in Node.js and in web apps shipped inside a native app. Optionally, `await Pulse.setUser('stable-user-id')` uses your own user id instead of the anonymous install id (see below).

Public calls do not throw and their promises do not reject. Signals tracked before `init` are kept (the newest 100) and sent afterwards. Only the first `init` call has an effect. No page, click or navigation signals are created automatically.

## What is sent and what is never sent

Sent with every signal: your signal name, optional number and properties, a UTC timestamp, the debug flag, a random session id, the platform (`web`, `node` or `mobile`), coarse OS name and version when available, locale, your configured app version, and the SDK name and version. What else is sent depends on where the code runs. A field the platform cannot give is left out. In a browser, the SDK sends nothing from crawlers and automated browsers.

| Where | Extra fields |
| --- | --- |
| **Node.js** | Device: `deviceType` (`desktop`), `architecture`, `runtimeVersion`. Settings: `timeZone`, `utcOffsetMinutes`, `language`, `preferredLanguage`, `region`. App: `isDebugBuild`, plus `appName` and `appBuildNumber` if you pass them. Usage statistics (below). |
| **Native app wrapper** | Device: `deviceType`, `deviceModel`, `targetEnvironment` (`capacitor`, `cordova` or `webview`). Screen: `screenWidth`, `screenHeight`, `screenScale`, `screenWidthPx`, `screenHeightPx`, `orientation`. Settings and accessibility: `colorScheme`, `reduceMotion`, `increaseContrast`, `invertColors`, `layoutDirection`, `timeZone`, `utcOffsetMinutes`, `language`, `preferredLanguage`, `region`. Network: `connectionType`. App: `isDebugBuild`, plus `appName` and `appBuildNumber` if you pass them. Usage statistics (below). |
| **Normal browser** | Only: `language`, `preferredLanguage`, `timeZone`, `utcOffsetMinutes`, `colorScheme`, `reduceMotion`, `increaseContrast`, `deviceType`. No screen size, connection type or other values that help to recognise a device. Nothing is stored for analytics (App Control keeps its last answer, see App Control below). |

Usage statistics (Node.js and native app wrappers): `firstSessionDate`, `totalSessionsCount`, `distinctDaysUsed`, `distinctDaysUsedLastMonth`, `previousSessionSeconds`, `averageSessionSeconds`, `sessionSeconds`, and `isNewInstall` during the first session. They are kept in one small file next to the install id (`<storagePath>.usage`, or `usage-<first 16 hex of the app key hash>` under `~/.mightys-pulse/`) or, in a wrapper, in `localStorage` under `mightys-pulse:usage:<app key>`. Opt-out deletes them. If storage fails they are kept in memory for the process.

Automatic signals (Node.js and native app wrappers): `pulse.session_started` once per session, `pulse.new_install` on the first launch and `pulse.app_updated` (with `previousVersion` and `previousBuild`) when the app version or build changed since the last launch. At most one of each per session, usually far fewer. A normal browser sends none of them because it has nowhere to keep the statistics.

Sessions use a random id that changes after 30 minutes of inactivity.

Anonymous install id: random, created by the SDK on first launch, stored only in the app's own storage, deleted with the app, replaced after opt-out, sent only as a SHA-256 hash, not derived from any device identifier, not shared between apps. It is how users are counted without any setup. Where it lives depends on where the code runs:

- **Node.js:** a small file next to the queue file (`<storagePath>.install-id`), or one file per app key under `~/.mightys-pulse/` in the default layout. All processes of one app share it.
- **Native app wrapper** (a web game or app shipped inside an iOS or Android app, for example with Capacitor or Cordova, or in a WebView): `localStorage` under `mightys-pulse:install:<app key>`, which belongs to the app. The wrapper is recognised from positive evidence only.
- **Normal browser:** no identifier is stored on the device and no user hash is sent unless you call `setUser`.

User id: optional. If you call `setUser`, the id is hashed with SHA-256 on the device and sent instead of the install id. The raw id is never stored or sent. The hash is pseudonymous and can link one user's signals. `setUser(null)` goes back to the install id (or to no user hash in a normal browser).

Never sent: cookies, advertising or device identifiers, device names, fingerprinting data (canvas, fonts, high-entropy Client Hints, and in a normal browser screen size and connection type), location, referrers, page titles. No URL is read, except the three utm_ campaign tags of the landing page. Browsers add their ordinary User-Agent header to any request; the SDK adds nothing to it.

IP address: the SDK does not read or send the device's IP address as data. As with any HTTP request, the server sees the connection address, uses it only to derive a two-letter country code and does not store it.

Do not put personal data in signal names, properties or app versions: they are sent as given and, in the offline queue, stored unencrypted.

## Options

| Option | Default | Accepted values |
| --- | --- | --- |
| `host` | `https://in.mightys.dev` | HTTP(S) base URL without credentials, query or fragment. An invalid host leaves the client uninitialized. |
| `flushIntervalSeconds` | `20` | Number from 1 to 3600. |
| `maxBatchSize` | `100` | Integer from 1 to 1000. |
| `maxQueueSize` | `1000` | Integer from 1 to 100000. |
| `maxQueueAgeDays` | `7` | Number up to 30. Values above 29 act as 29. |
| `gzip` | `true` | Compresses request bodies above 1024 bytes. |
| `automaticScreenViews` | `true` | Browser and native app wrappers: sends `pulse.screen_view` on route changes. `false` installs nothing. See Screen views below. |
| `allowAutomatedBrowsers` | `false` | Browser and native app wrappers: by default nothing is sent, stored or requested when `navigator.webdriver` is true or the user agent names a known crawler, headless browser or page-speed tool (inside a native app wrapper only `webdriver` counts). Set `true` in a test harness that drives a real browser. |
| `captureErrors` | `true` | Browser, native app wrappers and Node.js: sends unhandled errors, rejections and crashes as `pulse.error`. `false` installs nothing; `Pulse.trackError` still works. See Errors and crashes below. |
| `captureHeatmaps` | `true` | Browser and native app wrappers: `true` follows the portal (heatmaps are off until it switches them on); `false` never captures taps. See Heatmaps below. |
| `errorDetail` | `'full'` | `'full'` sends the error type, a filtered message and frames. `'typeOnly'` sends only the kind and the type. |
| `automaticSignals` | `true` | Node and native app wrappers: sends `pulse.session_started`, `pulse.new_install` and `pulse.app_updated`, and in native app wrappers the app events, deep links and permission changes of Automatic signals. It can only switch them off; see Settings from the portal below. |
| `control` | `'automatic'` | `'automatic'` checks App Control and shows the built-in screens. `'manual'` checks and keeps `Pulse.control` up to date but draws nothing. `'off'` makes no request at all. See App Control below. |
| `debug` | development builds: `true`; otherwise `false` | Marks signals as test data and enables warnings, which never contain signal or user data. See Test mode below. |
| `appVersion` | `''` | String of at most 512 UTF-16 code units. |
| `appBuildNumber` | `''` | Node and native app wrappers. String of at most 64 characters. |
| `appName` | `''` | Node and native app wrappers. String of at most 64 characters. |
| `storagePath` | per-process files under `~/.mightys-pulse/` | Node only. A queue file for exactly one process; consent is stored in `<storagePath>.consent`, the install id in `<storagePath>.install-id` and the usage statistics in `<storagePath>.usage` and the portal settings in `<storagePath>.config`. |

Invalid numeric and boolean values fall back to their defaults.

## Automatic signals

What the SDK sends on its own, and how to switch each part off. Defaults and the signal cost of every type are in the [automatic signals table](https://pulse.mightys.dev/docs/automatic-signals/).

| Signal | Where | Switch off |
| --- | --- | --- |
| `pulse.session_started`, `pulse.new_install`, `pulse.app_updated` | Node.js, native app wrappers | `automaticSignals: false` |
| `pulse.screen_view` | browser, native app wrappers (Node: `Pulse.screen`) | `automaticScreenViews: false` |
| `pulse.app_opened`, `pulse.app_backgrounded` | native app wrappers, only when the portal lists them in `enabledSignals` | `automaticSignals: false` |
| `pulse.deep_link` | native app wrappers, one call: `Pulse.deepLink(url)` | `automaticSignals: false` |
| `pulse.permission_changed` | native app wrappers | `automaticSignals: false` |
| `pulse.error` | browser, native app wrappers, Node.js | `captureErrors: false` |
| `pulse.heatmap` | browser, native app wrappers, only when the portal switches `heatmaps` on | `captureHeatmaps: false` (and `automaticSignals: false`) |

The portal can pause any type (`pausedSignals`) or switch it off (`disabledSignals`); `app_opened` and `app_backgrounded` stay off until the portal switches them on. A type that is switched off is not sent, whatever the code says, and options in code can only switch things off.

Extra data on signals, all on by default and part of the same switches:

- `previousScreenSeconds` on every `pulse.screen_view` that has a previous screen: the time that screen was visible, in whole seconds, without time in the background (browser and native app wrappers; Node counts wall time).
- `previousScrollPercent` (0 to 100): how far down the previous page the reader got, browser and native app wrappers only.
- `utmSource`, `utmMedium` and `utmCampaign` on the first screen view of a page load, from the `utm_source`, `utm_medium` and `utm_campaign` tags of the landing page. Nothing else from the URL is read: no URL is read, except the three utm_ campaign tags of the landing page. Values are filtered like error text and at most 64 characters.
- Native app wrappers only: `launchMs` on the `pulse.session_started` of a cold start (the time from the start of the page to the first signal); `foregroundsToday` and `previousForegroundSeconds` (group `usage`); `notificationPermission` (`granted`, `denied` or `notDetermined`, group `permissions`), read as a status. The SDK never asks for a permission. `pulse.permission_changed` (props `permission`, `from`, `to`) is sent once on the first signal after the status changed.
- Node.js: `launchMs` from the process uptime at the first signal. No foreground or background data.
- `pulse.deep_link` has the props `scheme`, `host` and `path` (numeric and uuid-like segments as `:id`, at most 128 characters) and the three campaign tags of the link. The query, the fragment and other parameters are never read.
- A normal browser sends none of the native app wrapper data: no app events, no `launchMs`, no foreground counters, no permissions and no deep links.

Limits that protect your plan: at most 20 `pulse.app_opened`, 20 `pulse.app_backgrounded`, 10 `pulse.deep_link`, 5 `pulse.permission_changed` and 100 `pulse.screen_view` per session, and at most 300 automatic signals per install and local day (kept next to the usage statistics, so Node.js and native app wrappers; a normal browser has no install and only the per-session limits apply). Manual signals and `pulse.error` are never limited this way. Signals dropped by a limit are counted and the count is sent once as the system key `droppedAutomatic` on the next signal. A `pulse.app_backgrounded` that arrives 30 minutes or more after the last signal is dropped instead of starting a session of its own.

## Screen views

In a browser and in a native app wrapper the SDK sends a `pulse.screen_view` signal for the first page and for every route change (`history.pushState`, `history.replaceState`, back and forward, and `hashchange`). It has the props `screen` and, once there was an earlier screen, `previousScreen`, `previousScreenSeconds` and (browser and native app wrappers) `previousScrollPercent`.

- The name is the route path only (the hash path for hash routers such as `#/level/3`). The query, the fragment, the full URL and the page title are never read, except the three utm_ tags on the first screen view of a page load (see Automatic signals). Numeric and uuid-like segments become `:id`, so `/user/42/orders` is sent as `/user/:id/orders`. Names are at most 128 characters.
- The same name twice in a row is sent once.
- A normal browser sends it too and stores nothing for it. Opt-out and `debug` apply as for any signal.
- The History API is wrapped once; the original method always runs first.
- To switch it off, pass `automaticScreenViews: false`. Nothing is then wrapped or listened to.
- Node.js never sends screen views on its own. In any environment, `Pulse.screen('Menu')` sends one by name (the same limits and dedupe apply).

## Heatmaps

Heatmaps are off until you switch them on for the app in the portal; code can only switch them off (`captureHeatmaps: false`). When on, the browser and native app wrappers send `pulse.heatmap` signals: the screen name (as in `pulse.screen_view`), where the tap or click landed (x as a share of the width, y in px from the top of the page), the width bucket, the orientation and the kind: `tap`, `rage` (the 3rd or later tap within 1 second and 30 px) or `dead` (a click that changed neither the address, the page nor the focus within 1 second).

- **Collected:** screen name, position, kind. **Never collected:** text, element ids, classes or URLs, recordings, anything typed, the soft keyboard. Taps on inputs, selects, editable content and anything inside an element with `data-pulse-ignore` are never captured; nothing is captured while the soft keyboard is visible on a touch device.
- **Ignore an element:** add `data-pulse-ignore` to it or to any ancestor.
- **No screenshots from the web SDK.** To see the picture, the portal opens your page with a one-time token in the address fragment; the SDK removes it from the address bar, loads the overlay module from the Pulse host and draws the heatmap over your live page. Normal visitors never load it.
- At most 200 points per signal and 1000 per session. `pulse.heatmap` is not counted by the automatic signal limits.

## Errors and crashes

Unhandled errors are sent by default as a `pulse.error` signal with an `error` object: `kind` (`crash`, `error` or `handled`), `type`, a filtered `message`, `frames` and `symbolicated`. It is a normal signal: `automaticSignals: false` does not stop it.

- **Browser and native app wrapper:** the window `error` event and `unhandledrejection` (kind `error`). Only listeners are added: `window.onerror` and your own listeners keep running, and nothing is prevented or replaced.
- **Node.js:** an uncaught exception is sent with kind `crash`, a rejection that ends the process with kind `error`. The SDK listens with `process.on('uncaughtExceptionMonitor')`, which only observes: your own `uncaughtException` listeners still decide whether the process goes on, and without one Node prints the error and exits with its usual code, unchanged. The queue is written to disk synchronously before that, so the crash is sent at the next start. A `process.on('unhandledRejection')` listener is added only if your app already has one when `init` runs. Rejections are only seen with Node's default handling (`--unhandled-rejections=throw`), or through your own listener.
- **What is sent:** `type` is `error.name` (or the constructor name; for a thrown string or number, `StringError` or `NumberError`). `frames` are read from `error.stack` (Chrome, Node, Firefox and Safari formats), at most 30 of at most 300 characters, as `function file.js:line:column`: only the file name, never a host, directory or query. Line and column stay as numbers.
- **Filter:** in the message and in every frame the SDK replaces emails, the query string and fragment of URLs, UUIDs, IP addresses and runs of 6 or more digits with `<filtered>` (hexadecimal literals such as `0x1234567` are kept), and keeps only the file name of file paths. The `error` object is at most 16384 bytes and the message at most 500 characters.
- **`errorDetail: 'typeOnly'`** sends only `kind` and `type`.
- **Limit:** at most 10 `pulse.error` signals per session per error type; more are dropped.
- **Handled errors:** `Pulse.trackError(error, props?)` sends kind `handled`, also when `captureErrors` is `false`.
- **Symbolication:** frames of minified bundles carry `symbolicated: false`; their names are not readable until source maps are supported.
- `captureErrors: false` installs no listener. Opt-out stops capture.

```js
try { await checkout(); } catch (error) { Pulse.trackError(error, { screen: 'cart' }); throw error; }
```

## Settings from the portal

The portal can switch things off for your app without a package update: screen views, the automatic signals (together or one type at a time), and groups of fields (device, screen, settings, network, app, usage). Everything is on by default.

- The SDK asks for the settings once per launch, in the background, and never waits for the answer. A failed request changes nothing.
- In Node.js and native app wrappers the answer is kept next to the install id (`<storagePath>.config`, `config-<first 16 hex of the app key hash>` under `~/.mightys-pulse/`, or `localStorage` under `mightys-pulse:config:<app key>`) and applies from the next launch. Opt-out deletes it with the rest.
- A normal browser stores nothing: the settings are asked for once per page load and apply to the rest of that page. Signals sent before the answer arrives use the defaults.
- When the settings cannot be read (offline, an error, no answer yet), everything is on.
- Options in code can only switch things off: `automaticScreenViews: false` and `automaticSignals: false` stay off whatever the portal says, and they never turn on what the portal switched off.
- A group that is switched off leaves its fields out of every signal. The base fields (platform, OS, app version, locale, SDK name and version, device model) are always sent.
- If you opt out and back in during a run, the settings are asked for again at the next launch.

## App Control

App Control lets you change what your app does from the Pulse portal, without a release: ask for an update, put the app into maintenance, announce something or show what is new. It needs no setup. It starts by itself after `Pulse.init`, and a page or app that has nothing to show never loads any of its screens.

- **What it does.** In the background (never blocking `init`), once after `init` and each time the page or app comes back to the front (at most once a minute), the SDK reads the rules for your app from the Pulse host. The request carries no app key, no install id, no user and no cookie, and it also runs when analytics is opted out. It waits at most 3 seconds for the answer to start and 5 seconds in all, reads at most 65536 bytes and never retries in a loop.
- **A normal web page** shows maintenance (a full screen that cannot be closed), a heads-up bar before a planned maintenance, announcements and a what's new card. Required and suggested updates are never drawn on a web page, because reloading the page is the update; they stay in the state for `manual` mode. What's new is shown once, after `appVersion` changed on this device to the version of the card, so it needs the `appVersion` option.
- **Inside a native app wrapper** (Capacitor, Cordova, a web view) every kind is drawn. The Update button opens the store link from the rules through the system (Capacitor and Cordova) or by navigation. A required update without a store link becomes a suggestion, so a user is never locked in without a way out.
- **Node.js** has no screen: `await Pulse.control.get()` returns the state, and your tool decides what to do. Its request never keeps the process alive, so a short-lived CLI exits when its own work is done.
- **The screens** live in a closed Shadow DOM, so your CSS never reaches them and they never reach your page. They follow `prefers-color-scheme` and `prefers-reduced-motion`, use the system font and sizes in `rem`, set all text as text, and can be read by a screen reader (`aria-modal`, labelled and described). A screen that cannot be closed keeps the focus inside, makes the page behind it inert and ignores Escape; the other screens close with Escape. Texts are built in for 12 languages (en, de, fr, es, it, pt-BR, ja, ko, zh-Hans, tr, ru, sr-Latn), chosen by the page language, then the browser language, then English; custom texts from the portal replace them. The screens are never drawn for crawlers and automated browsers.
- **Size.** The main bundle carries only the request and its cache. The decision and the screens are a separate module, `@mightys-dev/pulse/control`, which the main bundle loads with a dynamic `import()` only when the rules ask for something. Bundlers split it into its own file; the CommonJS builds load it with `require`.

```js
// Node.js: a command line tool that stops when the portal requires an update.
import { Pulse } from '@mightys-dev/pulse';

Pulse.init(process.env.PULSE_APP_KEY, { appVersion: '1.4.0', appName: 'my-cli' });
const state = await Pulse.control.get();
if (state.kind === 'updateRequired') {
  console.error(`${state.title}: ${state.body}${state.url ? ` ${state.url}` : ''}`);
  process.exitCode = 1;
}
```

```js
// A web page that draws its own screens.
Pulse.init(key, { appVersion: '2.3.0', control: 'manual' });
const stop = Pulse.control.subscribe(state => { if (state.kind === 'maintenance') showMyMaintenancePage(state); });
```

| Call | Behaviour |
| --- | --- |
| `await Pulse.control.get()` | The state once the first check has finished (at most 5 seconds); `normal` at once when `control` is `'off'`. It never rejects. |
| `Pulse.control.subscribe(listener)` | Calls `listener(state)` on every change and returns a function that stops it. A listener that throws never breaks the SDK. |
| `await Pulse.control.checkNow()` | Checks the rules now. It never rejects. |
| `Pulse.control.openStore()` | Opens `state.url` (the store page) where there is one. |
| `Pulse.control.dismiss()` | Leaves the current state where it allows that: a suggestion (not shown again to this app version for 24 hours), a card (not shown again on this device) or a screen with `allowContinue`. Screens that cannot be left ignore it. |

The state has `kind` (`normal`, `updateSuggested`, `updateRequired`, `versionBlocked`, `maintenance`, `maintenanceUpcoming`, `announcement` or `whatsNew`), `title`, `body`, `buttonText`, `secondaryButtonText`, `url`, `startsAt` and `endsAt` (ISO 8601, UTC), `version`, `allowContinue`, `isTestBuild` and `testBuildText`.

**How it fails safely.** Anything that goes wrong keeps the last known state from the cache, or `normal`: no network, DNS or TLS errors, a timeout, any status except 200 and 304, an answer that is not a JSON object of format 1 or is larger than 65536 bytes, a field of an unknown type. Unknown fields are ignored and a link that is not a web link counts as missing. Rules that lock (a required update or a blocked version) are ignored when the cache is more than 30 days old, a maintenance window from the cache never applies after its end or for more than 72 hours, and a window or an announcement starts and ends on the device clock, also offline. Three presses of Update that come back to the same version, or a store version that is not newer than the installed one, turn a required update into a suggestion. In a debug build every locking screen shows "Test build: App Control preview" and a Continue button. The portal can switch App Control off for all apps or for one SDK version at once. The SDK never closes the app and there is no Exit button.

**What is stored.** Two small records without any identifier: the last answer (`mightys-pulse:control:<first 16 hex of the hash of the app key>` in `localStorage`; in Node `control-<hash>` next to the install id, or `<storagePath>.control`) and what the device remembers about the screens (`mightys-pulse:control-local:<hash>`, `control-local-<hash>` or `<storagePath>.control-local`: the last app version, the announcements shown, when a suggestion was closed). Opt-out does not touch them.

## Test mode

Every signal carries a `debug` flag. `debug: true` marks it as test data, and the dashboard's test mode switch chooses whether you see test or real signals. One app key serves both, so you need one key per app. An explicit `debug` option always wins. Without it, the choice is made once, at `init`:

- **Node:** `NODE_ENV` set to `development` or `test` means test data. Anything else, including unset, means real data.
- **Browser:** the SDK follows `process.env.NODE_ENV` when your bundler replaces it at build time. A page without such a replacement counts as real data, so set the option yourself.

```js
Pulse.init(key, { debug: location.hostname === 'localhost' }); // or, in Vite: { debug: import.meta.env.DEV }
```

## Delivery and offline behaviour

- Signals are batched. The first batch is sent as soon as possible; later batches follow the interval or the batch size, whichever comes first.
- The queue is persisted (localStorage in browsers, files in Node) and survives reloads and restarts. Oldest signals are dropped first when the queue is full or expired.
- Failed requests (network errors, 408, 425, 429, 5xx) are retried with exponential backoff from 1 second to 5 minutes, honouring `Retry-After` up to one hour. A 401 keeps the queue and stops sending until reload.
- When the server asks for a pause or a different interval, the SDK follows it.
- In browsers, when the page is hidden or unloading, the SDK makes one best-effort keepalive request. If the browser drops it, the signals stay queued and are sent from the next page.
- Each batch carries an id, so a batch sent again after a lost answer is stored only once.
- Delivery is at least once: a signal can arrive twice, for example when a response is lost after the server accepted the request.
- Each browser tab keeps its own queue. A queue left by a closed tab is adopted by the next tab that starts. In Node, queue files of exited processes are adopted at start.
- Request bodies are gzipped when larger than 1024 bytes and never exceed 1 MiB or 1000 signals.

## Requirements

| | Supported |
| --- | --- |
| Node.js | 22.12 and newer (native `fetch`). |
| Browsers | ES2022. `fetch` and `TextEncoder` are required for sending. Persistence, gzip and user hashing (WebCrypto, which needs HTTPS) degrade safely when unavailable. |
| Module formats | ESM and CommonJS, with TypeScript declarations for both. |

## Opt-out

`Pulse.optOut(true)` clears pending signals, the user hash and the stored install id, cancels active requests where possible and stores the choice. Nothing is collected or sent while it is on. Other open tabs of the same site apply it at once. Requests already sent cannot be recalled. `Pulse.optOut(false)` turns collection back on with a new install id; a user hash from `setUser` needs a new `setUser` call. If the stored choice cannot be read, the SDK counts as opted out. App Control keeps working and keeps its two records, because it sends no identity and reads no analytics data.

## Licence

MIT.

## Reference

| Call | Behaviour |
| --- | --- |
| `Pulse.init(key, options?)` | Initializes once per module instance. |
| `Pulse.track(type, { value?, props? }?)` | Queues a signal. |
| `await Pulse.setUser(id)` | Optional. Hashes your id locally and uses it instead of the anonymous install id. `null` or an empty string goes back to the install id. Await it before tracking signals that should carry the new hash. If hashing fails, signals carry the install id hash. |
| `await Pulse.flush()` | Waits for initialization, persistence and the sends that are eligible now. It returns after an offline failure or a server pause and does not wait through backoff. |
| `Pulse.trackError(error, props?)` | Sends a handled error as `pulse.error`. See Errors and crashes. |
| `Pulse.optOut(enabled)` | See Opt-out. |
| `Pulse.control` | App Control: `get`, `subscribe`, `checkNow`, `openStore`, `dismiss`. See App Control. |

`PulseOptions`, `TrackOptions`, `PulseClient`, `ControlApi`, `ControlMode`, `ControlKind` and `ControlState` are exported types.

Signal rules: the name needs non-whitespace content and at most 200 UTF-16 code units. The value must be a finite number or null. Props accept strings, finite numbers and booleans (sent as `"true"` or `"false"`); other props are discarded. A signal whose props exceed 8192 UTF-8 bytes is discarded. Lone UTF-16 surrogates become U+FFFD.

Browser storage: the key `mightys-pulse:<app key>` holds only the consent choice (plus `mightys-pulse:install:<app key>` with the install id, only inside a native app wrapper), and each page keeps its queue under its own key, removed while empty. Node: with the default location, every process writes its own queue file under `~/.mightys-pulse/` and the processes share one consent file, one install id file and one usage statistics file; consent changes reach other running processes at their next start.
