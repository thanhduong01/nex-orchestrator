// Estimated USD prices per million tokens (Anthropic first-party API rates).
// cacheWrite5m / cacheWrite1h / cacheRead default to the standard multipliers
// (1.25x, 2x, 0.1x of input) unless a model lists its own value.
// Override or extend with a JSON file: NEX_PRICING=/path/pricing.json
// Note: on a Pro/Max subscription you don't pay per token — treat cost as an
// "API-equivalent" figure for comparing skills, not as a bill.
import fs from 'node:fs';

const BASE = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

let table = { ...BASE };
if (process.env.NEX_PRICING) {
  try {
    Object.assign(table, JSON.parse(fs.readFileSync(process.env.NEX_PRICING, 'utf8')));
  } catch (e) {
    console.error(`[nex-trace] cannot read NEX_PRICING: ${e.message}`);
  }
}

const FALLBACK = { input: 4, output: 20 };

export function priceFor(model = '') {
  const m = String(model).replace(/^(us\.|eu\.|global\.)?anthropic\./, '').replace(/\[.*\]$/, '');
  if (table[m]) return table[m];
  // tolerate dated / suffixed ids: longest known prefix wins
  const key = Object.keys(table).filter((k) => m.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (key) return table[key];
  // family guess
  if (m.includes('haiku')) return table['claude-haiku-5-5'];
  if (m.includes('sonnet')) return table['claude-sonnet-5-5'];
  if (m.includes('fable') || m.includes('mythos')) return table['claude-fable-5-2'];
  return FALLBACK;
}

/** usage: {in, out, cw5m, cw1h, cr} in tokens → USD */
export function costOf(model, u, fast = false) {
  const p = priceFor(model);
  const mult = fast ? 2 : 1;
  const cr = p.cacheRead ?? p.input * 0.1;
  const cw5 = p.cacheWrite5m ?? p.input * 1.25;
  const cw1 = p.cacheWrite1h ?? p.input * 2;
  return (
    (u.in * p.input + u.out * p.output + u.cw5m * cw5 + u.cw1h * cw1 + u.cr * cr) * mult
  ) / 1e6;
}
