import { Pulse } from '../dist/node.js';

const key = process.env.PULSE_APP_KEY;
if (!key) {
  console.error('Set PULSE_APP_KEY to a public v1 application key.');
  process.exitCode = 1;
} else {
  Pulse.init(key, { appVersion: 'example-1', ...(process.env.PULSE_HOST ? { host: process.env.PULSE_HOST } : {}) });
  Pulse.track('example.node', { value: 1, props: { example: true } });
  await Pulse.flush();
  console.log('Eligible send attempts finished; pending signals remain in the durable queue.');
}
