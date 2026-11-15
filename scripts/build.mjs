import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = resolve(root, 'dist');
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const identityOnly = {
  name: 'identity-only',
  setup(builder) {
    // Keep the single metadata source without shipping build scripts or tooling metadata.
    builder.onLoad({ filter: /package\.json$/ }, args => args.path === resolve(root, 'package.json')
      ? { contents: JSON.stringify({ name: metadata.name, version: metadata.version }), loader: 'json' }
      : undefined);
  },
};
async function removeGenerated(path) {
  const target = resolve(root, path);
  if (target !== output && !target.startsWith(output + sep)) throw new Error('Unsafe build cleanup path.');
  await rm(target, { recursive: true, force: true });
}
await removeGenerated('dist');
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
// Shortens only internal, in-memory property names that never reach the wire, storage or the public API, and that no
// platform object uses. Never add a persisted field (version, optOut, queue, batches, indices, gzip, body) or a wire field.
const mangleProps = /^(signals|bytes|timeouts|intervalSeconds|pauseUntil|retryAfter|claim|watch|consent|done)$/;
for (const entry of ['web', 'node']) {
  for (const format of ['esm', 'cjs']) {
    await build({ entryPoints: [`src/${entry}.ts`], bundle: true, minify: true, format, platform: entry === 'node' ? 'node' : 'browser',
      target: 'es2022', outfile: `dist/${entry}.${format === 'esm' ? 'js' : 'cjs'}`, legalComments: 'none', plugins: [identityOnly], mangleProps });
  }
}
// Publish declarations for both module systems, including transitive references.
async function declarations(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) await declarations(path);
    else if (item.name.endsWith('.d.ts')) {
      const relative = path.slice('dist/types/src/'.length);
      const target = `dist/${relative}`;
      await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      await copyFile(path, target);
      await writeFile(target.replace(/\.d\.ts$/, '.d.cts'), (await readFile(path, 'utf8')).replace(/(\.\/[^'"]*|\.\.\/[^'"]*)\.js(['"])/g, '$1.cjs$2'));
    }
  }
}
await declarations('dist/types/src');
// Guard: a .d.cts that still points at a .js file makes TypeScript treat the import as an ES module (TS1542 under node16).
for (const file of await readdir('dist', { recursive: true })) {
  if (file.endsWith('.d.cts') && /\.js['"]/.test(await readFile(`dist/${file}`, 'utf8'))) throw new Error(`dist/${file} still references a .js module.`);
}
await removeGenerated('dist/types');
console.log('Built ESM, CJS and declarations for web and Node.');
