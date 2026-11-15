import { Pulse, type PulseOptions } from '@mightys-dev/pulse';
import { Pulse as Browser } from '@mightys-dev/pulse/web';
import { Pulse as Node } from '@mightys-dev/pulse/node';
const options: PulseOptions = { appVersion: '1.0.0' };
void [Pulse, Browser, Node, options];
