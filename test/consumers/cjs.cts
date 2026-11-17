import { Pulse, type ControlState, type PulseOptions } from '@mightys-dev/pulse';
import { Pulse as Browser } from '@mightys-dev/pulse/web';
import { Pulse as Node } from '@mightys-dev/pulse/node';
import { attach, type ControlKind } from '@mightys-dev/pulse/control';

const options: PulseOptions = { appVersion: '1.0.0', control: 'off' };
const kind: ControlKind = 'announcement';
const read = async (): Promise<ControlState> => Node.control.get();
void [Pulse, Browser, Node, options, attach, kind, read];
