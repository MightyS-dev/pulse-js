// Scheduling fields follow the v1 ingest contract; error is informational, not a scheduling override.
export class ServerPolicy {
  intervalSeconds: number | undefined;
  pauseUntil = 0;

  apply(body: string | undefined, now: number, fallbackIntervalSeconds = 20): void {
    try {
      const data: unknown = JSON.parse(body ?? '');
      // Destructuring null throws into the catch; primitives and arrays yield undefined fields.
      const { recommendedSendIntervalSeconds: interval, pause } = data as Record<string, unknown>;
      if (Number.isFinite(interval) && (interval as number) >= 5 && (interval as number) <= 3600) this.intervalSeconds = interval as number;
      if (typeof pause === 'boolean') this.pauseUntil = pause
        ? now + (this.intervalSeconds ?? Math.max(5, Math.min(3600, fallbackIntervalSeconds))) * 1000
        : 0;
    } catch { /* Empty and unknown response bodies are valid. */ }
  }
}
