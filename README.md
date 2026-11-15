# MightyS Pulse for JavaScript

Privacy-first analytics for web apps, browser games and Node.js. No cookies, no device IDs, offline queue, under 5 kB gzipped.

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
await Pulse.setUser('stable-user-id'); // optional
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

Public calls do not throw and their promises do not reject. Signals tracked before `init` are kept (the newest 100) and sent afterwards. Only the first `init` call has an effect. No page, click or navigation signals are created automatically.

## What is sent and what is never sent

Sent with every signal: your signal name, optional number and properties, a UTC timestamp, the debug flag, a random session id, the platform (`web` or `node`), coarse OS name and version when available, locale, your configured app version, and the SDK name and version.

Sessions use a random id that changes after 30 minutes of inactivity.

User id: optional. If you call `setUser`, the id is hashed with SHA-256 on the device. The raw id is never stored or sent. The hash is pseudonymous and can link one user's signals. Without `setUser`, no user hash is sent. `setUser(null)` clears it.

Never sent: cookies, persistent device or advertising identifiers, device names or hardware details, fingerprinting data (canvas, fonts, screen, high-entropy Client Hints), location, page URLs, referrers, page titles. Browsers add their ordinary User-Agent header to any request; the SDK adds nothing to it.

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
| `storagePath` | per-process files under `~/.mightys-pulse/` | Node only. A queue file for exactly one process; consent is stored in `<storagePath>.consent`. |

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

`Pulse.optOut(true)` clears pending signals and the user hash, cancels active requests where possible and stores the choice. Nothing is collected or sent while it is on. Other open tabs of the same site apply it at once. Requests already sent cannot be recalled. `Pulse.optOut(false)` turns collection back on; a new user hash needs a new `setUser` call. If the stored choice cannot be read, the SDK counts as opted out.

## Licence

MIT.

## Reference

| Call | Behaviour |
| --- | --- |
| `Pulse.init(key, options?)` | Initializes once per module instance. |
| `Pulse.track(type, { value?, props? }?)` | Queues a signal. |
| `await Pulse.setUser(id)` | Hashes the id locally. `null` or an empty string clears it. Await it before tracking signals that should carry the new hash. If hashing fails, signals are sent without a user hash. |
| `await Pulse.flush()` | Waits for initialization, persistence and the sends that are eligible now. It returns after an offline failure or a server pause and does not wait through backoff. |
| `Pulse.optOut(enabled)` | See Opt-out. |

`PulseOptions`, `TrackOptions` and `PulseClient` are exported types.

Signal rules: the name needs non-whitespace content and at most 200 UTF-16 code units. The value must be a finite number or null. Props accept strings, finite numbers and booleans (sent as `"true"` or `"false"`); other props are discarded. A signal whose props exceed 8192 UTF-8 bytes is discarded. Lone UTF-16 surrogates become U+FFFD.

Browser storage: the key `mightys-pulse:<app key>` holds only the consent choice, and each page keeps its queue under its own key, removed while empty. Node: with the default location, every process writes its own queue file under `~/.mightys-pulse/` and the processes share one consent file; consent changes reach other running processes at their next start.
