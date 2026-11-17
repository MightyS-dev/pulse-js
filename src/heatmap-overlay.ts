import { routeName } from './adapters/route.js';
import { bucketOf } from './heatmap.js';

/** The reply of `GET /api/v1/heatmap/overlay` (HeatmapGrid in the API contract), the fields this module reads. */
export interface Grid {
  columns: number;
  cell_height_px: number;
  rows: number;
  total_points: number;
  max_cell: number;
  cells: { x: number; y: number; tap: number; rage: number; dead: number }[];
}
export interface MountOptions { token: string; host: string }
export type Kind = 'tap' | 'rage' | 'dead';
export const KINDS: Kind[] = ['tap', 'rage', 'dead'];
const COLORS: Record<Kind, string> = { tap: '255,140,0', rage: '220,30,30', dead: '40,90,230' };

/** One box per cell and visible layer, in percent of the page width and px from the top; opacity grows with the count. */
export function boxes(grid: Grid, layers: Record<Kind, boolean>): { left: number; top: number; width: number; height: number; color: string; title: string }[] {
  const out = [];
  for (const cell of grid.cells) {
    for (const kind of KINDS) {
      const count = cell[kind];
      if (!layers[kind] || count <= 0) continue;
      const alpha = 0.15 + 0.6 * Math.min(1, count / Math.max(1, grid.max_cell));
      out.push({ left: cell.x * 100 / grid.columns, top: cell.y * grid.cell_height_px, width: 100 / grid.columns, height: grid.cell_height_px,
        color: `rgba(${COLORS[kind]},${alpha.toFixed(2)})`, title: `${kind}: ${count}` });
    }
  }
  return out;
}

/** Reads the grid of the current page (the same screen name, bucket and orientation the SDK sends) with the overlay token. */
export async function load(options: MountOptions, env: Record<string, any> = globalThis): Promise<Grid> {
  const w = env.innerWidth as number;
  const query = new URLSearchParams({ screen: routeName(env.location.pathname, env.location.hash), bucket: bucketOf(w),
    orientation: env.innerHeight >= w ? 'portrait' : 'landscape' });
  const response = await env.fetch(`${options.host}/api/v1/heatmap/overlay?${query}`, {
    headers: { 'X-Pulse-Overlay-Token': options.token }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  if (response.status !== 200) throw new Error('overlay');
  return await response.json() as Grid;
}

/** Draws the grid over the live page: one toggle per layer, counts as the hover title. Its only network call is `load`. */
export async function mount(options: MountOptions, env: Record<string, any> = globalThis): Promise<{ remove(): void }> {
  const grid = await load(options, env);
  const doc = env.document as Document;
  const layers: Record<Kind, boolean> = { tap: true, rage: true, dead: true };
  const root = doc.createElement('div');
  root.setAttribute('data-pulse-ignore', '');
  root.style.cssText = 'position:absolute;left:0;top:0;width:100%;pointer-events:none;z-index:2147483646;';
  root.style.height = `${Math.max(grid.rows * grid.cell_height_px, doc.documentElement.scrollHeight)}px`;
  const layer = doc.createElement('div');
  root.appendChild(layer);
  const panel = doc.createElement('div');
  panel.style.cssText = 'position:fixed;right:8px;bottom:8px;pointer-events:auto;background:#fff;color:#111;font:12px sans-serif;padding:6px 8px;border-radius:6px;box-shadow:0 1px 6px #0006;';
  const draw = (): void => {
    layer.textContent = '';
    for (const box of boxes(grid, layers)) {
      const cell = doc.createElement('div');
      cell.title = box.title;
      cell.style.cssText = `position:absolute;pointer-events:auto;left:${box.left}%;top:${box.top}px;width:${box.width}%;height:${box.height}px;background:${box.color};`;
      layer.appendChild(cell);
    }
  };
  for (const kind of KINDS) {
    const label = doc.createElement('label');
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => { layers[kind] = box.checked; draw(); });
    label.append(box, ` ${kind} `);
    panel.appendChild(label);
  }
  root.appendChild(panel);
  doc.body.appendChild(root);
  draw();
  return { remove: () => root.remove() };
}
