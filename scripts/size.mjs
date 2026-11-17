import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

// The main web bundle must stay under the limit. App Control loads from its own file (dist/control.js) and is not part of it.
const LIMIT = 13900;
const size = async name => {
  const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
  return { bytes: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
};
const web = await size('web.js');
console.log(`Web ESM: ${web.bytes} bytes; gzip (level 9): ${web.gzip} bytes; target: < ${LIMIT} bytes.`);
const control = await size('control.js');
console.log(`App Control module (loaded only when the portal asks for something): ${control.bytes} bytes; gzip (level 9): ${control.gzip} bytes.`);
if (web.gzip >= LIMIT) process.exitCode = 1;
