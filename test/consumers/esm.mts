import { Pulse, type ControlState, type PulseOptions, type TrackOptions } from '@mightys-dev/pulse';
import { Pulse as Browser } from '@mightys-dev/pulse/web';
import { Pulse as Node } from '@mightys-dev/pulse/node';
import { attach, type ControlKind } from '@mightys-dev/pulse/control';

const options: PulseOptions = { maxBatchSize: 10, storagePath: 'synthetic.json', control: 'manual' };
const signal: TrackOptions = { value: 4.99, props: { sku: 'gems_100', valid: true } };
const kind: ControlKind = 'maintenance';
const read = async (): Promise<ControlState> => Pulse.control.get();
const stop = Browser.control.subscribe(state => { void state.kind; });
// Compile-only consumer checks. No client is initialized by this module.
void [Pulse, Browser, Node, options, signal, attach, kind, read, stop];
