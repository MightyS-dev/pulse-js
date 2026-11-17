import { browserPlatform } from './adapters/browser.js';
import { createPulse } from './core.js';
export type { ErrorInfo } from './errors.js';
export type { ControlApi, ControlKind, ControlMode, ControlState, PulseClient, PulseOptions, TrackOptions } from './types.js';
export const Pulse = createPulse(browserPlatform());
