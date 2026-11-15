import { Pulse, type PulseOptions, type TrackOptions } from '@mightys-dev/pulse';
import { Pulse as Browser } from '@mightys-dev/pulse/web';
import { Pulse as Node } from '@mightys-dev/pulse/node';

const options: PulseOptions = { maxBatchSize: 10, storagePath: 'synthetic.json' };
const signal: TrackOptions = { value: 4.99, props: { sku: 'gems_100', valid: true } };
// Compile-only consumer checks. No client is initialized by this module.
void [Pulse, Browser, Node, options, signal];
