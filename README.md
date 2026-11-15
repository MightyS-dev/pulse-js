# MightyS Pulse for JavaScript

Privacy-first analytics for web apps, browser games and Node.js. No cookies, no device IDs, offline queue, under 8 kB gzipped.

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

Sent with every signal: your signal name, optional number and properties, a UTC timestamp, the debug flag, a random session id, the platform (`web`, `node` or `mobile`), coarse OS name and version when available, locale, your configured app version, and the SDK name and version. What else is sent depends on where the code runs. A field the platform cannot give is left out.

| Where | Extra fields |
| --- | --- |
| **Node.js** | Device: `deviceType` (`desktop`), `architecture`, `runtimeVersion`. Settings: `timeZone`, `utcOffsetMinutes`, `language`, `preferredLanguage`, `region`. App: `isDebugBuild`, plus `appName` and `appBuildNumber` if you pass them. Usage statistics (below). |
| **Native app wrapper** | Device: `deviceType`, `deviceModel`, `targetEnvironment` (`capacitor`, `cordova` or `webview`). Screen: `screenWidth`, `screenHeight`, `screenScale`, `screenWidthPx`, `screenHeightPx`, `orientation`. Settings and accessibility: `colorScheme`, `reduceMotion`, `increaseContrast`, `invertColors`, `layoutDirection`, `timeZone`, `utcOffsetMinutes`, `language`, `preferredLanguage`, `region`. Network: `connectionType`. App: `isDebugBuild`, plus `appName` and `appBuildNumber` if you pass them. Usage statistics (below). |
| **Normal browser** | Only: `language`, `preferredLanguage`, `timeZone`, `utcOffsetMinutes`, `colorScheme`, `reduceMotion`, `increaseContrast`, `deviceType`. No screen size, connection type or other values that help to recognise a device. Nothing is stored. |

Usage statistics (Node.js and native app wrappers): `firstSessionDate`, `totalSessionsCount`, `distinctDaysUsed`, `distinctDaysUsedLastMonth`, `previousSessionSeconds`, `averageSessionSeconds`, `sessionSeconds`, and `isNewInstall` during the first session. They are kept in one small file next to the install id (`<storagePath>.usage`, or `usage-<first 16 hex of the app key hash>` under `~/.mightys-pulse/`) or, in a wrapper, in `localStorage` under `mightys-pulse:usage:<app key>`. Opt-out deletes them. If storage fails they are kept in memory for the process.

Automatic signals (Node.js and native app wrappers): `pulse.session_started` once per session, `pulse.new_install` on the first launch and `pulse.app_updated` (with `previousVersion` and `previousBuild`) when the app version or build changed since the last launch. At most one of each per session, usually far fewer. A normal browser sends none of them because it has nowhere to keep the statistics.

Sessions use a random id that changes after 30 minutes of inactivity.

Anonymous install id: random, created by the SDK on first launch, stored only in the app's own storage, deleted with the app, replaced after opt-out, sent only as a SHA-256 hash, not derived from any device identifier, not shared between apps. It is how users are counted without any setup. Where it lives depends on where the code runs:

- **Node.js:** a small file next to the queue file (`<storagePath>.install-id`), or one file per app key under `~/.mightys-pulse/` in the default layout. All processes of one app share it.
- **Native app wrapper** (a web game or app shipped inside an iOS or Android app, for example with Capacitor or Cordova, or in a WebView): `localStorage` under `mightys-pulse:install:<app key>`, which belongs to the app. The wrapper is recognised from positive evidence only.
- **Normal browser:** no identifier is stored on the device and no user hash is sent unless you call `setUser`.

User id: optional. If you call `setUser`, the id is hashed with SHA-256 on the device and sent instead of the install id. The raw id is never stored or sent. The hash is pseudonymous and can link one user's signals. `setUser(null)` goes back to the install id (or to no user hash in a normal browser).

Never sent: cookies, advertising or device identifiers, device names, fingerprinting data (canvas, fonts, high-entropy Client Hints, and in a normal browser screen size and connection type), location, page URLs, referrers, page titles. Browsers add their ordinary User-Agent header to any request; the SDK adds nothing to it.

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
| `debug` | development builds: `true`; otherwise `false` | Marks signals as test data and enables warnings, which never contain signal or user data. See Test mode below. |
| `appVersion` | `''` | String of at most 512 UTF-16 code units. |
| `appBuildNumber` | `''` | Node and native app wrappers. String of at most 64 characters. |
| `appName` | `''` | Node and native app wrappers. String of at most 64 characters. |
| `storagePath` | per-process files under `~/.mightys-pulse/` | Node only. A queue file for exactly one process; consent is stored in `<storagePath>.consent`, the install id in `<storagePath>.install-id` and the usage statistics in `<storagePath>.usage`. |

Invalid numeric and boolean values fall back to their defaults.

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

`Pulse.optOut(true)` clears pending signals, the user hash and the stored install id, cancels active requests where possible and stores the choice. Nothing is collected or sent while it is on. Other open tabs of the same site apply it at once. Requests already sent cannot be recalled. `Pulse.optOut(false)` turns collection back on with a new install id; a user hash from `setUser` needs a new `setUser` call. If the stored choice cannot be read, the SDK counts as opted out.

## Licence

MIT.

## Reference

| Call | Behaviour |
| --- | --- |
| `Pulse.init(key, options?)` | Initializes once per module instance. |
| `Pulse.track(type, { value?, props? }?)` | Queues a signal. |
| `await Pulse.setUser(id)` | Optional. Hashes your id locally and uses it instead of the anonymous install id. `null` or an empty string goes back to the install id. Await it before tracking signals that should carry the new hash. If hashing fails, signals carry the install id hash. |
| `await Pulse.flush()` | Waits for initialization, persistence and the sends that are eligible now. It returns after an offline failure or a server pause and does not wait through backoff. |
| `Pulse.optOut(enabled)` | See Opt-out. |

`PulseOptions`, `TrackOptions` and `PulseClient` are exported types.

Signal rules: the name needs non-whitespace content and at most 200 UTF-16 code units. The value must be a finite number or null. Props accept strings, finite numbers and booleans (sent as `"true"` or `"false"`); other props are discarded. A signal whose props exceed 8192 UTF-8 bytes is discarded. Lone UTF-16 surrogates become U+FFFD.

Browser storage: the key `mightys-pulse:<app key>` holds only the consent choice (plus `mightys-pulse:install:<app key>` with the install id, only inside a native app wrapper), and each page keeps its queue under its own key, removed while empty. Node: with the default location, every process writes its own queue file under `~/.mightys-pulse/` and the processes share one consent file, one install id file and one usage statistics file; consent changes reach other running processes at their next start.
