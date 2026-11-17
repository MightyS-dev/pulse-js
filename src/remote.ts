/** Switchable field groups and the keys this SDK can send in each (the portal's groups hold a few more for other platforms). */
const GROUPS: Record<string, string> = {
  device: 'deviceType architecture runtimeVersion targetEnvironment',
  screen: 'screenWidth screenHeight screenScale screenWidthPx screenHeightPx orientation',
  settings: 'colorScheme layoutDirection timeZone utcOffsetMinutes language preferredLanguage region reduceMotion invertColors increaseContrast',
  network: 'connectionType',
  app: 'appName isDebugBuild',
  usage: 'isNewInstall firstSessionDate totalSessionsCount distinctDaysUsed distinctDaysUsedLastMonth previousSessionSeconds averageSessionSeconds sessionSeconds foregroundsToday previousForegroundSeconds',
  permissions: 'notificationPermission',
};

/** Settings from the portal. Everything is on unless the settings say otherwise. */
export interface Remote {
  version: number | undefined;
  automatic: boolean;
  off: string[];
  hidden: string[];
  /** Opt-in types the portal switched on; none without settings. */
  enabled: string[];
  /** Types the portal paused. */
  paused: string[];
  /** Heatmap capture switched on in the portal; off without settings. */
  heatmaps: boolean;
}

export const ALL_ON: Remote = { version: undefined, automatic: true, off: [], hidden: [], enabled: [], paused: [], heatmaps: false };

/** Missing keys and values that are not booleans mean on; unknown keys are ignored. Anything unreadable gives undefined. */
export function parseRemote(text: string | null | undefined): Remote | undefined {
  try {
    const data = JSON.parse(text ?? '') as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;
    const groups = (data.groups ?? {}) as Record<string, unknown>;
    const list = (v: unknown): string[] => Array.isArray(v) ? v.filter(s => typeof s === 'string') : [];
    return {
      version: data.version as number,
      automatic: data.automaticSignals !== false,
      // Switched-off screen views count as a disabled signal type.
      off: [...list(data.disabledSignals), ...data.screenViews === false ? ['pulse.screen_view'] : []],
      enabled: list(data.enabledSignals),
      paused: list(data.pausedSignals),
      heatmaps: data.heatmaps === true,
      hidden: Object.entries(GROUPS).flatMap(([name, keys]) => groups[name] === false ? keys.split(' ') : []),
    };
  } catch { /* A bad body is no settings. */ }
}
