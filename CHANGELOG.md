# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

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
