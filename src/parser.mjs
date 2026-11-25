// Parses Claude Code transcripts (~/.claude/projects/**/*.jsonl) into a flat,
// dashboard-friendly model: sessions → turns → API calls → tool calls,
// with every call/tool attributed to the skill that was active at that moment.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costOf } from './pricing.mjs';

export function defaultRoot() {
  if (process.env.CLAUDE_PROJECTS_DIR) return process.env.CLAUDE_PROJECTS_DIR;
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

export function listTranscripts(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line)); } catch { /* partial line while writing */ }
  }
  return recs;
}

// Built-in slash commands that are not skills.
const BUILTIN = new Set(['clear', 'compact', 'model', 'help', 'config', 'cost', 'status', 'login', 'logout',
  'resume', 'memory', 'permissions', 'hooks', 'mcp', 'agents', 'exit', 'quit', 'init', 'doctor', 'bug',
  'review', 'vim', 'theme', 'terminal-setup', 'add-dir', 'export', 'context', 'usage', 'fast', 'effort',
  'plugin', 'plugins', 'skills', 'rewind', 'statusline', 'ide', 'upgrade', 'release-notes', 'artifacts']);

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
};
const sizeOf = (v) => {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((s, b) => s + (b?.type === 'text' ? (b.text || '').length : b?.type === 'image' ? 4000 : JSON.stringify(b).length), 0);
  return JSON.stringify(v).length;
};
const clip = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const host = (u) => { try { return new URL(u).host; } catch { return clip(u, 60); } };

/** Where a tool call "goes": category + short target. */
export function classifyTool(name, input = {}) {
  input = input || {};
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return { cat: 'mcp', dest: `mcp:${server}`, target: rest.join('__'), detail: clip(JSON.stringify(input), 200) };
  }
  switch (name) {
    case 'Bash': case 'BashOutput': case 'KillShell': {
      const cmd = String(input.command || '');
      // skip leading `cd x &&`, `VAR=value;` and `VAR=value cmd` prefixes to find the real program
      const rest = cmd.replace(/^\s*((cd\s+[^&;\n]+|[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s;&]*))\s*(&&|;|\n)?\s*)+/, '');
      const first = rest.trim().split(/\s+/)[0] || name;
      return { cat: 'shell', dest: `shell:${path.basename(first)}`, target: path.basename(first), detail: clip(cmd, 240) };
    }
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'NotebookRead':
      return { cat: 'file', dest: `file:${name}`, target: input.file_path || input.notebook_path || '', detail: input.file_path || '' };
    case 'Glob': case 'Grep': case 'LS':
      return { cat: 'search', dest: `search:${name}`, target: input.pattern || input.path || '', detail: clip(JSON.stringify(input), 200) };
    case 'WebFetch':
      return { cat: 'web', dest: `web:${host(input.url)}`, target: host(input.url), detail: input.url || '' };
    case 'WebSearch':
      return { cat: 'web', dest: 'web:search', target: clip(input.query, 80), detail: input.query || '' };
    case 'Skill': case 'SlashCommand': {
      const s = String(input.skill || input.command || '').replace(/^\//, '').split(/\s+/)[0];
      return { cat: 'skill', dest: `skill:${s}`, target: s, detail: clip(input.args || '', 200) };
    }
    case 'Task': case 'Agent':
      return { cat: 'agent', dest: `agent:${input.subagent_type || 'general'}`, target: input.subagent_type || 'general-purpose', detail: clip(input.description || input.prompt, 200) };
    default:
      return { cat: 'other', dest: `tool:${name}`, target: name, detail: clip(JSON.stringify(input), 200) };
  }
}

function usageOf(u = {}) {
  const cw = u.cache_creation || {};
  const cwTotal = u.cache_creation_input_tokens || 0;
  let cw1h = cw.ephemeral_1h_input_tokens || 0;
  let cw5m = cw.ephemeral_5m_input_tokens || 0;
  if (cw1h + cw5m === 0) cw5m = cwTotal;
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    think: u.output_tokens_details?.thinking_tokens || 0,
    cw5m, cw1h,
    cr: u.cache_read_input_tokens || 0,
    webSearch: u.server_tool_use?.web_search_requests || 0,
    fast: u.speed === 'fast',
  };
}

function slashCommandOf(text) {
  const m = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text);
  if (!m) return null;
  const name = m[1];
  return BUILTIN.has(name) ? null : name;
}

/**
 * Parse one transcript file. Returns a "run": main session or subagent.
 */
export function parseTranscript(file) {
  const recs = readJsonl(file);
  const isSubFile = /[\\/]subagents[\\/]/.test(file);
  const run = {
    file,
    id: path.basename(file, '.jsonl'),
    sessionId: null,
    agentId: null,
    isSubagent: isSubFile,
    parentSessionId: isSubFile ? path.basename(path.dirname(path.dirname(file))) : null,
    project: path.basename(isSubFile ? path.dirname(path.dirname(path.dirname(file))) : path.dirname(file)),
    cwd: null, gitBranch: null, version: null, title: null,
    start: null, end: null,
    turns: [], calls: [], tools: [], invocations: [],
  };

  const callById = new Map();
  const toolById = new Map();
  let turn = -1;
  let activeInv = null; // invocation index
  let pendingSkillTools = []; // Skill tool ids from the current call; activate after call

  const startTurn = (rec, prompt, slash) => {
    turn = run.turns.length;
    run.turns.push({ idx: turn, ts: rec.timestamp, prompt: clip(prompt, 400), slash: slash || null });
    activeInv = null;
    pendingSkillTools = [];
    if (slash) {
      activeInv = run.invocations.length;
      run.invocations.push({ idx: activeInv, skill: slash, via: 'slash', ts: rec.timestamp, turn, promptChars: 0, args: clip(prompt, 200) });
    }
  };

  for (const rec of recs) {
    if (rec.sessionId && !run.sessionId) run.sessionId = rec.sessionId;
    if (rec.agentId && !run.agentId) run.agentId = rec.agentId;
    if (rec.cwd && !run.cwd) run.cwd = rec.cwd;
    if (rec.gitBranch && !run.gitBranch) run.gitBranch = rec.gitBranch;
    if (rec.version) run.version = rec.version;
    if (rec.type === 'ai-title' && rec.aiTitle) run.title = rec.aiTitle;
    if (rec.type === 'summary' && rec.summary && !run.title) run.title = rec.summary;
    if (rec.timestamp) {
      if (!run.start || rec.timestamp < run.start) run.start = rec.timestamp;
      if (!run.end || rec.timestamp > run.end) run.end = rec.timestamp;
    }
    // Inline sidechain records (old format) are skipped here; subagent files are parsed separately.
    if (rec.isSidechain && !isSubFile) continue;

    if (rec.type === 'user' && rec.message) {
      const content = rec.message.content;
      const blocks = Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b?.type === 'tool_result');
      for (const r of results) {
        const t = toolById.get(r.tool_use_id);
        if (!t) continue;
        t.done = true;
        t.isError = !!r.is_error;
        t.resultChars = sizeOf(r.content);
        if (rec.timestamp && t.ts) t.durationMs = Date.parse(rec.timestamp) - Date.parse(t.ts);
        const tur = rec.toolUseResult;
        if (tur && typeof tur === 'object') {
          if (tur.agentId) t.agentId = tur.agentId;
          if (tur.totalTokens) t.subTotalTokens = tur.totalTokens;
          if (tur.totalToolUseCount) t.subToolCount = tur.totalToolUseCount;
          if (tur.totalDurationMs) t.durationMs = tur.totalDurationMs;
        }
      }
      if (results.length) continue;

      const text = textOf(content);
      if (rec.isMeta) {
        // Skill body injected after a Skill tool call → measure its size.
        const inv = rec.sourceToolUseID && run.invocations.find((i) => i.toolId === rec.sourceToolUseID);
        if (inv) inv.promptChars += text.length;
        else if (activeInv != null && run.invocations[activeInv]?.via === 'slash') run.invocations[activeInv].promptChars += text.length;
        continue;
      }
      if (!text.trim()) continue;
      if (/^<(local-command-stdout|local-command-stderr)>/.test(text.trim())) continue;
      if (text.startsWith('Caveat: The messages below')) continue;
      if (isSubFile && run.turns.length === 0) { startTurn(rec, text, null); continue; }
      const slash = slashCommandOf(text);
      const prompt = slash ? text.replace(/<[^>]+>/g, ' ') : text;
      startTurn(rec, prompt, slash);
      continue;
    }

    if (rec.type === 'assistant' && rec.message) {
      const m = rec.message;
      if (m.model === '<synthetic>') continue;
      if (turn < 0) startTurn(rec, '(no prompt)', null);
      const cid = m.id || rec.requestId || rec.uuid;
      let call = callById.get(cid);
      if (!call) {
        // a new API call: activate skills invoked by the previous call
        if (pendingSkillTools.length) {
          activeInv = pendingSkillTools[pendingSkillTools.length - 1];
          pendingSkillTools = [];
        }
        call = { idx: run.calls.length, id: cid, ts: rec.timestamp, model: m.model, turn, inv: activeInv, tools: [] };
        Object.assign(call, usageOf(m.usage));
        callById.set(cid, call);
        run.calls.push(call);
      } else if (m.usage) {
        const u = usageOf(m.usage);
        call.out = Math.max(call.out, u.out); call.think = Math.max(call.think, u.think);
        call.in = Math.max(call.in, u.in); call.cr = Math.max(call.cr, u.cr);
        call.cw5m = Math.max(call.cw5m, u.cw5m); call.cw1h = Math.max(call.cw1h, u.cw1h);
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'tool_use') continue;
        if (toolById.has(b.id)) continue;
        const c = classifyTool(b.name, b.input);
        const t = { idx: run.tools.length, id: b.id, ts: rec.timestamp, name: b.name, ...c, turn, call: call.idx, inv: call.inv, done: false, isError: false, resultChars: 0, inputChars: JSON.stringify(b.input || {}).length };
        toolById.set(b.id, t);
        run.tools.push(t);
        call.tools.push(t.idx);
        if (c.cat === 'skill' && c.target) {
          const invIdx = run.invocations.length;
          run.invocations.push({ idx: invIdx, skill: c.target, via: 'tool', ts: rec.timestamp, turn, toolId: b.id, promptChars: 0, args: c.detail, parentInv: call.inv });
          pendingSkillTools.push(invIdx);
        }
      }
    }
  }

  for (const c of run.calls) {
    c.cost = costOf(c.model, c, c.fast);
    c.ctx = c.in + c.cw5m + c.cw1h + c.cr;
  }
  return run;
}

/** Parse everything under root (with an mtime cache) and link subagents to parents. */
const cache = new Map();
export function loadAll(root = defaultRoot(), { since } = {}) {
  const files = listTranscripts(root);
  const runs = [];
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (since && st.mtimeMs < since) continue;
    const hit = cache.get(f);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { runs.push(hit.run); continue; }
    try {
      const run = parseTranscript(f);
      run.mtime = st.mtimeMs;
      cache.set(f, { mtimeMs: st.mtimeMs, size: st.size, run });
      runs.push(run);
    } catch (e) {
      console.error(`[nex-trace] skip ${f}: ${e.message}`);
    }
  }
  return link(runs);
}

function link(runs) {
  const sessions = new Map();
  // runs are cached between reloads, so rebuild the links from scratch each time
  for (const r of runs) if (!r.isSubagent) { r.subagents = []; sessions.set(r.sessionId || r.id, r); }
  const orphans = [];
  for (const r of runs) {
    if (!r.isSubagent) continue;
    const parent = sessions.get(r.parentSessionId) || sessions.get(r.sessionId);
    if (!parent) { orphans.push(r); continue; }
    const aid = r.agentId || r.id.replace(/^agent-/, '');
    const tool = parent.tools.find((t) => t.agentId && (t.agentId === aid || r.id.endsWith(t.agentId)));
    r.parentTool = tool ? tool.idx : null;
    r.parentTurn = tool ? tool.turn : null;
    r.parentInv = tool ? tool.inv : null;
    if (tool) r.subagentType = tool.target;
    (parent.subagents ||= []).push(r);
  }
  return { sessions: [...sessions.values()], orphans };
}

/** Compact JSON for the dashboard. */
export function toDashboardData(all) {
  const strip = (r) => ({
    id: r.sessionId || r.id, file: r.file, project: r.project, cwd: r.cwd, branch: r.gitBranch, version: r.version,
    title: r.title, start: r.start, end: r.end, mtime: r.mtime, agentId: r.agentId, subagentType: r.subagentType,
    parentTool: r.parentTool, parentTurn: r.parentTurn, parentInv: r.parentInv,
    turns: r.turns, invocations: r.invocations,
    calls: r.calls.map(({ tools, ...c }) => c),
    tools: r.tools,
    subagents: (r.subagents || []).map(strip),
  });
  return {
    generatedAt: new Date().toISOString(),
    sessions: all.sessions.map(strip).sort((a, b) => String(b.start).localeCompare(String(a.start))),
    orphans: all.orphans.map(strip),
  };
}

/** Cheap fingerprint of all transcripts: used to detect live changes. */
export function snapshot(root = defaultRoot()) {
  const m = new Map();
  for (const f of listTranscripts(root)) {
    try { const st = fs.statSync(f); m.set(f, `${st.mtimeMs}:${st.size}`); } catch { /* gone */ }
  }
  return m;
}
