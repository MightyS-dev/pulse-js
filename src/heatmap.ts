import type { HeatmapInfo, HeatPoint, HeatTap } from './types.js';

/** At most this many points leave in one signal, and in one session. */
const PER_SIGNAL = 200;
const PER_SESSION = 1000;
const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));

/** The width bucket of a logical width: phone below 600, tablet below 1024, else desktop. */
export const bucketOf = (width: number): string => width < 600 ? 'phone' : width < 1024 ? 'tablet' : 'desktop';

/** The open buffer of taps for one (screen, bucket, orientation), the rage cluster and the points counted in this session. */
export class Heat {
  buffer: HeatmapInfo | undefined;
  /** Time of the latest point in the open buffer. */
  last = 0;
  total = 0;
  private cluster: [number, number, number, number] | undefined;

  /** Adds a tap and calls `send` with every buffer that closes; returns the stored point, or nothing when it was dropped. */
  add(screen: string, tap: HeatTap, now: number, send: (info: HeatmapInfo, at: number) => void): HeatPoint | undefined {
    const { x, y, width, height } = tap;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || this.total >= PER_SESSION) return;
    const bucket = bucketOf(width);
    const orientation = height >= width ? 'portrait' : 'landscape';
    const open = this.buffer;
    if (open && (open.screen !== screen || open.bucket !== bucket || open.orientation !== orientation)) this.close(send);
    // A tap joins the cluster when it is within 1 s of the first tap and 30 px of it; the 3rd and later are rage.
    const first = this.cluster;
    const joins = first && now - first[0] <= 1000 && Math.hypot(x - first[1], y - first[2]) <= 30;
    this.cluster = joins ? [first![0], first![1], first![2], first![3] + 1] : [now, x, y, 1];
    const point: HeatPoint = { x: Math.round(clamp(x / width, 1) * 1000) / 1000, y: Math.round(clamp(y, 100000) * 10) / 10, kind: this.cluster[3] > 2 ? 'rage' : 'tap' };
    (this.buffer ??= { screen, bucket, orientation, points: [] }).points.push(point);
    this.last = now;
    this.total++;
    if (this.buffer.points.length >= PER_SIGNAL) this.close(send);
    return point;
  }

  has(point: HeatPoint): boolean { return !!this.buffer?.points.includes(point); }

  /** Sends the open buffer, if it holds points. */
  close(send: (info: HeatmapInfo, at: number) => void): void {
    const info = this.buffer;
    this.buffer = undefined;
    if (info?.points.length) send(info, this.last);
  }

  /** Drops the buffer and the cluster; the session count stays. */
  reset(): void { this.buffer = undefined; this.cluster = undefined; }
}
