# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [0.9.7] - 2026-11-16

### Added

- Errors and crashes with where they happened. By default the SDK sends unhandled errors and rejections (browser and native app wrapper: window `error` and `unhandledrejection`) and Node.js crashes (`uncaughtExceptionMonitor`) as `pulse.error`, with the error type, a filtered message and readable frames (`function file.js:line:column`). Existing listeners keep running and Node's own behaviour does not change. A crash in Node is written to the queue synchronously and sent at the next start.
- `Pulse.trackError(error, props?)` sends a handled error.
- New options `captureErrors` (default `true`; `false` installs nothing) and `errorDetail` (`'full'` or `'typeOnly'`). At most 10 error signals per session per type. Emails, URL query strings and fragments, UUIDs, IP addresses, long digit runs and directories are replaced or removed before anything is sent.

- A crash right after start is now kept and sent on the next launch.
- New automatic data, on by default. `pulse.screen_view` gets `previousScreenSeconds` (visible time of the previous screen, without time in the background) and, in browsers and native app wrappers, `previousScrollPercent`. The first screen view of a page load gets `utmSource`, `utmMedium` and `utmCampaign` from the landing URL's `utm_source`, `utm_medium` and `utm_campaign` tags; nothing else from the URL is read.
- Native app wrappers: `launchMs` on the first session start of a page load, `foregroundsToday` and `previousForegroundSeconds`, `notificationPermission` (status only, the SDK never asks) and `pulse.permission_changed`. `Pulse.deepLink(url)` sends `pulse.deep_link` (scheme, host, path with ids as `:id`, campaign tags; never the query). `pulse.app_opened` and `pulse.app_backgrounded` are sent only when the portal switches them on (`enabledSignals`). A plain browser sends none of this. Node.js sends `launchMs` from the process uptime.
- Quota guards: per session at most 20 `pulse.app_opened`, 20 `pulse.app_backgrounded`, 10 `pulse.deep_link`, 5 `pulse.permission_changed` and 100 `pulse.screen_view`; per install and local day at most 300 automatic signals (Node.js and native app wrappers). Dropped signals are counted and sent once as `droppedAutomatic`. The portal setting `pausedSignals` pauses a type.
- A `pulse.app_backgrounded` 30 minutes or more after the last signal is dropped instead of opening a session.
- Heatmaps of clicks and taps (browser and native app wrappers; Node.js captures nothing). Off until the portal switches `heatmaps` on for the app. The SDK sends `pulse.heatmap` with the screen name, the position (x as a fraction of the width, y in px from the top of the page) and the kind (`tap`, `rage`, `dead`), at most 200 points per signal and 1000 per session. Never captured: the soft keyboard, text inputs, selects, editable content and anything inside `data-pulse-ignore`. No text, ids, classes or URLs. New option `captureHeatmaps` (default `true` follows the portal; `false` never captures).
- The portal can open your page with a one-time overlay token in the address fragment (`#pulse_overlay=...`). The SDK removes it from the address bar at once and loads a separate overlay module from the Pulse host, which draws the heatmap over the page. The module is its own file (`dist/heatmap-overlay.js`, also the export `@mightys-dev/pulse/heatmap-overlay`); normal visitors never load it.
- App Control: change what your app does from the Pulse portal, without a release. The SDK reads the rules for your app after `Pulse.init` (in the background, never blocking `init`) and every time the page or app comes back to the front, at most once a minute, and shows the matching screen: a required or suggested update, a blocked version, maintenance (also a heads-up bar before it), an announcement and what's new. The request carries no key, no install id and no cookie and also runs with analytics opted out.
- `Pulse.init(key, { control: 'automatic' | 'manual' | 'off' })`. `'automatic'` (default) shows the built-in screens, `'manual'` only keeps the state, `'off'` makes no request.
- `Pulse.control` with `get()` (a promise of the state, at most 5 seconds), `subscribe(listener)`, `checkNow()`, `openStore()` and `dismiss()`, plus the exported types `ControlApi`, `ControlMode`, `ControlKind` and `ControlState`. Node.js has no screen; `await Pulse.control.get()` returns the state, and the request never keeps the process alive.
- A normal web page shows maintenance, the heads-up bar, announcements and what's new; required and suggested updates stay in the state and are not drawn there. Native app wrappers (Capacitor, Cordova, web views) show every kind, and Update opens the store link through the system.
- The screens are built in 12 languages, live in a closed Shadow DOM and follow the colour scheme, reduced motion and the page's text size. A screen that cannot be closed traps the focus, makes the page behind it inert and ignores Escape.
- Everything fails safe: any error keeps the last known state or `normal`, locking rules from a cache older than 30 days are ignored, a required update without a store link or after three useless presses of Update becomes a suggestion, and the SDK never closes the app.
- New entry `@mightys-dev/pulse/control` (`dist/control.js`, `dist/control.cjs`): the decision and the screens. The main bundle loads it with `import()` only when the rules ask for something.
- The built-in update and maintenance screens are not counted as app screens or taps.

### Changed

- In an error frame, the line and column right after a file name are kept; the rest of the frame is still filtered. The message gets no such exemption.
- The web build is now under 14 kB gzipped (it was under 11.5 kB, under 10.5 kB with the error capture, under 9 kB before). The new automatic data and the heatmap capture needed room, and App Control adds about 0.8 kB gzipped to it: the request, the cache and the state. The decision and the screens are in the separate control entry, which a page with nothing to show never loads.

## [0.9.6] - 2026-11-16

### Fixed

- A new session starts after 30 minutes without signals, also across page loads and after a long gap, measured from the previous captured signal. A clock that moves back by 30 minutes or more also starts a new session.
- In a browser or native app wrapper the SDK sends, stores and requests nothing from crawlers and automated browsers (`navigator.webdriver` true, or a user agent of a known crawler, headless browser or page-speed tool). The new option `allowAutomatedBrowsers: true` turns this off for test harnesses.

## [0.9.5] - 2026-11-16

### Fixed

- A batch that is sent again after a lost answer is stored only once. Every batch carries an id (`X-Pulse-Batch`) that stays the same for every retry of that batch, also after a restart.

## [0.9.4] - 2026-11-16

### Added

- Automatic screen views in browsers and native app wrappers: a `pulse.screen_view` signal with `screen` and `previousScreen` for the first page and every route change (`pushState`, `replaceState`, back and forward, `hashchange`). The name is the route path only, with numeric and uuid-like segments shown as `:id`; no URL, query, fragment or page title is read. Switch it off with `automaticScreenViews: false`, which installs nothing.
- Settings from the portal: once per launch the SDK asks `GET /api/v1/config` for what the portal has switched off (screen views, automatic signals, field groups) and applies it from the next launch; a normal browser applies it to the rest of the page. Everything is on when the settings cannot be read. See Settings from the portal in the README.
- New option `automaticSignals` (default `true`): `false` stops `pulse.session_started`, `pulse.new_install` and `pulse.app_updated`. Options in code can only switch things off.
- `Pulse.screen(name)` sends a screen view by hand, in every environment including Node.js.

### Fixed

- Signals captured in the same millisecond keep their order: timestamps are strictly increasing.
- Node.js: the first launch with no stored install id now sends `pulse.new_install` (it was skipped, only `pulse.session_started` was sent).
- Node.js and native app wrappers: while `pulse.app_updated` is switched off (by `automaticSignals: false` or the portal), the stored app version is no longer moved on, so the update is reported once it is allowed again.

### Changed

- The web build is now under 9 kB gzipped (it was under 8 kB).

## [0.9.3] - 2026-11-15

### Added

- Signals now carry more context, with nothing for you to set up and nothing that identifies a person. Node.js: CPU architecture, Node version, device type, time zone and UTC offset, language and region. Inside a native app wrapper: screen size and scale, orientation, light or dark appearance, reduced motion, increased contrast, inverted colors, layout direction, connection type, device type, time zone and UTC offset, language and region, and whether it runs in Capacitor, Cordova or a plain WebView. A normal browser sends only a small coarse set: language, time zone, UTC offset, light or dark appearance, reduced motion, increased contrast and device type. Nothing new is stored there.
- Usage statistics in Node.js and native app wrappers: first session date, number of sessions, days used (all time and last 30 days), previous and average session length, and seconds into the current session.
- Three automatic signals in Node.js and native app wrappers, at most one per session: `pulse.session_started`, `pulse.new_install` (first launch) and `pulse.app_updated` (the app version or build changed). They respect opt-out and the `debug` setting. A normal browser sends none of them.
- New options `appBuildNumber` and `appName` (Node.js and native app wrappers).

### Changed

- On macOS, Node.js now reports the macOS version instead of the Darwin kernel version. On Windows and Linux the OS version keeps up to three numeric parts.
- A queue saved by an earlier launch inside a native app wrapper is now kept across restarts (the device model used to make it unreadable).
- The web build is now under 8 kB gzipped (it was under 5.5 kB).
- Opt-out also deletes the usage statistics file or entry.

## [0.9.2] - 2026-11-15

### Added

- Users are counted without any setup: the SDK sends a random anonymous install id (hashed) until you call `setUser`. It is kept in a file next to the queue in Node.js and in `localStorage` inside a native app wrapper (Capacitor, Cordova, Android WebView, iOS WKWebView). In a normal browser nothing is stored and no user hash is sent unless you call `setUser`.
- Inside a native app wrapper the platform is `mobile` and the device model is sent (the Android model name, or `iPhone` or `iPad`).

### Changed

- Opt-out also deletes the install id; turning it off again creates a new one.
- The Android OS version is now read when the browser reports the platform through Client Hints (it was empty before).
- The web build is now under 5.5 kB gzipped (it was under 5 kB).

## [0.9.1] - 2026-11-15

### Changed

- Without a `debug` option, signals from development builds are now marked as test data: in Node when `NODE_ENV` is `development` or `test`, in the browser when your bundler sets `process.env.NODE_ENV` to one of those. Everything else counts as real data. An explicit `debug` value always wins.

### Added

- README: a Test mode section that explains how signals are marked as test or real.

## [0.9.0] - 2026-11-15

Initial public release.

### Added

- `Pulse.init`, `Pulse.track`, `Pulse.setUser`, `Pulse.flush` and `Pulse.optOut` for sending named signals with an optional number and properties.
- Web build (localStorage queue) and Node build (atomic file queue), ESM and CommonJS, with TypeScript declarations. No runtime dependencies.
- Privacy by construction: no cookies, no advertising or device identifier, no fingerprinting. Sessions use random ids that rotate after 30 minutes of inactivity.
- Optional user id, hashed with SHA-256 on the device; the raw id is never stored or sent.
- One-call opt-out that is remembered and clears the queue.
- Batched delivery: first batch at once, then every 20 seconds by default or by batch size, gzipped request bodies, retries with backoff, and an offline queue that survives restarts.
- Public calls never throw into the host app and never block the main thread.
- Default ingest host `https://in.mightys.dev`, configurable with the `host` option.
