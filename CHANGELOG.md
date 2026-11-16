# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

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
