import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const bytes = await readFile(new URL('../dist/web.js', import.meta.url));
const gzip = gzipSync(bytes, { level: 9 }).byteLength;
console.log(`Web ESM: ${bytes.byteLength} bytes; gzip (level 9): ${gzip} bytes; target: < 5500 bytes.`);
if (gzip >= 5500) process.exitCode = 1;
