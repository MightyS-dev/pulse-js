import metadata from '../package.json' with { type: 'json' };

// Product identity and release version have one source each.
export const PRODUCT = 'MightyS Pulse';
export const identity = {
  sdkName: `${metadata.name.split('/')[1]}-js`,
  version: metadata.version,
};

export const DEFAULT_HOST = 'https://in.mightys.dev';
export const defaults = {
  host: DEFAULT_HOST,
  flushIntervalSeconds: 20,
  maxBatchSize: 100,
  maxQueueSize: 1000,
  maxQueueAgeDays: 7,
  gzip: true,
  automaticScreenViews: true,
  automaticSignals: true,
  debug: false,
  appVersion: '',
  appBuildNumber: '',
  appName: '',
};
