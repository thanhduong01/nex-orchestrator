// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAll, toDashboardData } from '../src/parser.mjs';
import { summarize } from '../src/summary.mjs';

const usage = (o) => ({ input_tokens: 10, output_tokens: o, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } });
const asst = (id, ts, content, out = 50, extra = {}) => ({ type: 'assistant', sessionId: 'S1', timestamp: ts, message: { id, model: 'claude-opus-5-5', content, usage: usage(out) }, ...extra });
const user = (ts, content, extra = {}) => ({ type: 'user', sessionId: 'S1', timestamp: ts, message: { role: 'user', content }, ...extra });
const tr = (id, ts, text, extra = {}) => user(ts, [{ type: 'tool_result', tool_use_id: id, content: text }], extra);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-'));
  const proj = path.join(root, '-home-me-app');
  fs.mkdirSync(path.join(proj, 'S1', 'subagents'), { recursive: true });
  const main = [
    user('2026-11-20T10:00:00Z', 'fix the bug'),
    asst('m1', '2026-11-20T10:00:01Z', [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'debugging' } }]),
    tr('t1', '2026-11-20T10:00:02Z', 'Launching skill: debugging'),
    user('2026-11-20T10:00:02Z', 'X'.repeat(4000), { isMeta: true, sourceToolUseID: 't1' }),
    // same API call split across two records (dedupe by message.id)
    asst('m2', '2026-11-20T10:00:03Z', [{ type: 'thinking', thinking: '' }]),
    asst('m2', '2026-11-20T10:00:03Z', [{ type: 'tool_use', id: 't2', name: 'mcp__github__get_file', input: { path: 'a' } }]),
    tr('t2', '2026-11-20T10:00:05Z', 'Y'.repeat(800)),
    asst('m3', '2026-11-20T10:00:06Z', [{ type: 'tool_use', id: 't3', name: 'Agent', input: { subagent_type: 'Explore', description: 'look' } }]),
    tr('t3', '2026-11-20T10:00:20Z', 'done', { toolUseResult: { agentId: 'abc', totalTokens: 999 } }),
    asst('m4', '2026-11-20T10:00:21Z', [{ type: 'text', text: 'fixed' }]),
    user('2026-11-20T11:00:00Z', 'thanks'),
    asst('m5', '2026-11-20T11:00:01Z', [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'cd x && npm test' } }]),
    tr('t4', '2026-11-20T11:00:09Z', 'fail', {}),
  ];
  main[main.length - 1].message.content[0].is_error = true;
  fs.writeFileSync(path.join(proj, 'S1.jsonl'), main.map((r) => JSON.stringify(r)).join('\n'));
  const sub = [
    user('2026-11-20T10:00:07Z', 'look', { isSidechain: true, agentId: 'abc' }),
    asst('s1', '2026-11-20T10:00:08Z', [{ type: 'tool_use', id: 'u1', name: 'WebFetch', input: { url: 'https://docs.example.com/x' } }], 70, { isSidechain: true, agentId: 'abc' }),
    tr('u1', '2026-11-20T10:00:10Z', 'page', { isSidechain: true, agentId: 'abc' }),
  ];
  fs.writeFileSync(path.join(proj, 'S1', 'subagents', 'agent-abc.jsonl'), sub.map((r) => JSON.stringify(r)).join('\n'));
  return root;
}

test('parses sessions, dedupes calls, attributes skills and subagents', () => {
  const data = toDashboardData(loadAll(fixture()));
  assert.equal(data.sessions.length, 1);
  const s = data.sessions[0];
  assert.equal(s.turns.length, 2);
  assert.equal(s.calls.length, 5, 'm2 counted once');
  assert.deepEqual(s.invocations.map((i) => i.skill), ['debugging']);
  assert.equal(s.invocations[0].promptChars, 4000);
  assert.equal(s.calls[0].inv, null, 'call that invokes the skill is outside it');
  assert.deepEqual(s.calls.slice(1, 4).map((c) => c.inv), [0, 0, 0]);
  assert.equal(s.calls[4].inv, null, 'next turn resets the skill');
  const mcp = s.tools.find((t) => t.name.startsWith('mcp__'));
  assert.equal(mcp.dest, 'mcp:github');
  assert.equal(mcp.resultChars, 800);
  assert.equal(mcp.durationMs, 2000);
  assert.equal(s.tools.find((t) => t.name === 'Bash').dest, 'shell:npm');
  assert.equal(s.tools.find((t) => t.name === 'Bash').isError, true);
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].parentInv, 0, 'subagent belongs to the skill run');
  assert.equal(s.subagents[0].tools[0].dest, 'web:docs.example.com');

  const sum = summarize(data);
  const dbg = sum.skills.find((k) => k.skill === 'debugging');
  assert.equal(dbg.runs, 1);
  assert.equal(dbg.calls, 4, '3 main calls + 1 subagent call');
  assert.equal(dbg.promptTokens, 1000);
  assert.ok(sum.totals.cost > 0);
});

test('reloading does not duplicate subagents', () => {
  const root = fixture();
  loadAll(root);
  const s = toDashboardData(loadAll(root)).sessions[0];
  assert.equal(s.subagents.length, 1);
});

test('shell destination skips cd and variable assignments', async () => {
  const { classifyTool } = await import('../src/parser.mjs');
  assert.equal(classifyTool('Bash', { command: 'S=/tmp/x; node a.js' }).dest, 'shell:node');
  assert.equal(classifyTool('Bash', { command: 'cd app && FOO=1 npm test' }).dest, 'shell:npm');
  assert.equal(classifyTool('Bash', { command: 'git status' }).dest, 'shell:git');
});
