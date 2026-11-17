import type { ControlEngine, ControlHost } from '../types.js';
import { createEngine } from './engine.js';
import { openUrl } from './open.js';
import { createUi } from './ui.js';

export type { ControlApi, ControlKind, ControlMode, ControlState } from '../types.js';

/**
 * Starts App Control with what the core knows. The core loads this module only when the rules ask for something.
 * The screens exist in a browser and in app wrappers; Node.js has none and the state is read from `Pulse.control`.
 */
export async function attach(shared: ControlHost['shared'], mode: ControlHost['mode'], options: ControlHost['options'], env: ControlHost['env'],
  clock: ControlHost['clock'], app: boolean, local: ControlHost['local'], check: ControlHost['check'], doc: Document | undefined = globalThis.document): Promise<ControlEngine> {
  // Positional, so that the always-loaded part of the SDK carries no property names for this hand-over.
  const host: ControlHost = { shared, mode, options, env, clock, app, local, check };
  const nav = globalThis.navigator as Navigator | undefined;
  const ui = doc?.documentElement ? createUi(doc) : undefined;
  return createEngine(host, {
    present: ui && ((state, actions) => ui.show(state, actions)),
    open: url => openUrl(url, host.app),
    tags: () => [doc?.documentElement?.lang, ...nav?.languages ?? [], nav?.language, host.env.info().locale],
    touch: (nav?.maxTouchPoints ?? 0) > 1,
  });
}
