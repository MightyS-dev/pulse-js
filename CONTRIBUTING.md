# Building and testing

Requires Node 22.12 or newer.

```sh
npm ci            # install the locked dev tools
npm run build     # bundle and type declarations into dist/
npm test          # type-check and run the test suite (build first: some tests load dist/)
npm run size      # report the minified and gzipped size of the web build
npm pack --dry-run   # list what the published package contains
```

The tests use only files in this repository. `test/fixtures/v1.jsonc` is the reference signal fixture.
