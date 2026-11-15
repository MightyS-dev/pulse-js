import { nodePlatform } from './adapters/node.js';
import { createPulse } from './core.js';
export type { PulseClient, PulseOptions, TrackOptions } from './types.js';
export const Pulse = createPulse(nodePlatform());
