// Aggregations shared by the CLI report (the browser has its own copy in index.html).
export function flatten(data) {
  const calls = [], tools = [], invs = [];
  const walk = (s, root, attrSkill) => {
    const skillOf = (inv) => (inv != null ? s.invocations[inv]?.skill : attrSkill) ?? null;
    for (const inv of s.invocations) invs.push({ ...inv, session: root.id, key: `${s.id}#${inv.idx}`, run: s });
    for (const c of s.calls) calls.push({ ...c, session: root.id, skill: skillOf(c.inv), sub: s !== root });
    for (const t of s.tools) tools.push({ ...t, session: root.id, skill: skillOf(t.inv), sub: s !== root });
    for (const sub of s.subagents || []) {
      const parentSkill = sub.parentInv != null ? s.invocations[sub.parentInv]?.skill : attrSkill;
      walk(sub, root, parentSkill ?? null);
    }
  };
  for (const s of data.sessions) walk(s, s, null);
  return { calls, tools, invs };
}

export function summarize(data) {
  const { calls, tools, invs } = flatten(data);
  const tok = (c) => c.ctx + c.out;
  const totals = {
    sessions: data.sessions.length, calls: calls.length,
    tokens: calls.reduce((a, c) => a + tok(c), 0), cost: calls.reduce((a, c) => a + c.cost, 0),
  };
  const sk = new Map();
  const get = (k) => sk.get(k) || (sk.set(k, { skill: k, runs: 0, tokens: 0, out: 0, cost: 0, calls: 0, tools: 0, errors: 0, promptTokens: 0 }), sk.get(k));
  for (const i of invs) { const r = get(i.skill); r.runs++; r.promptTokens += Math.round((i.promptChars || 0) / 4); }
  for (const c of calls) if (c.skill) { const r = get(c.skill); r.tokens += tok(c); r.out += c.out; r.cost += c.cost; r.calls++; }
  for (const t of tools) if (t.skill) { const r = get(t.skill); r.tools++; if (t.isError) r.errors++; }
  const skills = [...sk.values()].map((r) => ({ ...r, runs: r.runs || 1 })).sort((a, b) => b.cost - a.cost);
  const dm = new Map();
  for (const t of tools) {
    const d = dm.get(t.dest) || { dest: t.dest, cat: t.cat, count: 0, errors: 0, resultTokens: 0 };
    d.count++; if (t.isError) d.errors++; d.resultTokens += Math.round((t.resultChars || 0) / 4);
    dm.set(t.dest, d);
  }
  const dests = [...dm.values()].sort((a, b) => b.count - a.count);
  return { totals, skills, dests };
}
