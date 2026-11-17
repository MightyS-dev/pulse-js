interface Parsed { main: string[]; pre: string[] | undefined }

const DIGITS = /^\d+$/;
const PRE = /^[0-9A-Za-z-]+$/;

/** Numbers of any length compare by value: no leading zeros, then by length, then by digits. */
function compareNumbers(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  return x.length === y.length ? (x < y ? -1 : x > y ? 1 : 0) : x.length < y.length ? -1 : 1;
}

function parse(text: unknown): Parsed | undefined {
  if (typeof text !== 'string') return;
  let value = text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '').replace(/^[vV]/, '');
  const plus = value.indexOf('+');
  if (plus >= 0) value = value.slice(0, plus);
  let pre: string[] | undefined;
  const dash = value.indexOf('-');
  if (dash >= 0) {
    pre = value.slice(dash + 1).split('.');
    value = value.slice(0, dash);
    if (pre.some(part => !PRE.test(part))) return;
  }
  const main = value.split('.');
  if (!value || main.some(part => !DIGITS.test(part))) return;
  return { main, pre };
}

/** -1, 0 or 1; undefined when either version cannot be compared (empty or not numeric). */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return;
  for (let i = 0; i < Math.max(left.main.length, right.main.length); i++) {
    const order = compareNumbers(left.main[i] ?? '0', right.main[i] ?? '0');
    if (order) return order as -1 | 1;
  }
  const x = left.pre;
  const y = right.pre;
  if (!x || !y) return x === y ? 0 : x ? -1 : 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const numeric = DIGITS.test(p);
    const other = DIGITS.test(q);
    const order = numeric && other ? compareNumbers(p, q) : numeric ? -1 : other ? 1 : p < q ? -1 : p > q ? 1 : 0;
    if (order) return order as -1 | 1;
  }
  return 0;
}
