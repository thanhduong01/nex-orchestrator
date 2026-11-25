#!/usr/bin/env node
// nex-trace — track Claude Code runs: skills, tool calls ("where it goes"), tokens, cost.
//
//   nex-trace serve  [--port 7788] [--dir <projects dir>] [--days N]   live dashboard
//   nex-trace build  [--out nex-trace.html] [--dir ...] [--days N]     self-contained HTML snapshot
//   nex-trace json   [--out data.json] [--dir ...] [--days N]          raw data export
//   nex-trace report [--dir ...] [--days N]                            summary in the terminal
//   nex-trace statusline                                               Claude Code status line (reads stdin)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadAll, toDashboardData, defaultRoot, parseTranscript } from '../src/parser.mjs';
import { summarize } from '../src/summary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'public', 'index.html');

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'serve';
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const dir = opt('dir', defaultRoot());
const days = Number(opt('days', 0));
const since = days > 0 ? Date.now() - days * 864e5 : undefined;

const getData = () => toDashboardData(loadAll(dir, { since }));
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));

function htmlWithData(data) {
  const ui = fs.readFileSync(UI, 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return ui.replace('<!--NEX_DATA-->', `<script>window.__NEX_DATA__=${json};</script>`);
}

switch (cmd) {
  case 'serve': {
    const port = Number(opt('port', process.env.PORT || 7788));
    const hostArg = opt('host', '127.0.0.1');
    http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      try {
        if (url.pathname === '/api/data') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(getData()));
        } else if (url.pathname === '/' || url.pathname === '/index.html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(UI));
        } else { res.writeHead(404); res.end('not found'); }
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.stack || e));
      }
    }).listen(port, hostArg, () => {
      console.log(`nex-trace dashboard: http://${hostArg === '0.0.0.0' ? 'localhost' : hostArg}:${port}`);
      console.log(`reading transcripts from ${dir}`);
    });
    break;
  }
  case 'build': {
    const out = opt('out', 'nex-trace.html');
    fs.writeFileSync(out, htmlWithData(getData()));
    console.log(`wrote ${out}`);
    break;
  }
  case 'json': {
    const out = opt('out', null);
    const s = JSON.stringify(getData(), null, 1);
    if (out) { fs.writeFileSync(out, s); console.log(`wrote ${out}`); } else process.stdout.write(s);
    break;
  }
  case 'report': {
    const s = summarize(getData());
    console.log(`Sessions ${s.totals.sessions} · API calls ${s.totals.calls} · tokens ${fmt(s.totals.tokens)} · est. $${s.totals.cost.toFixed(2)}\n`);
    console.log('SKILL'.padEnd(34), 'RUNS'.padStart(5), 'TOKENS'.padStart(9), 'COST$'.padStart(8), '$/RUN'.padStart(7), 'TOOLS/RUN'.padStart(10), 'ERR%'.padStart(5), 'PROMPT~TOK'.padStart(11));
    for (const k of s.skills) {
      console.log(k.skill.slice(0, 34).padEnd(34), String(k.runs).padStart(5), fmt(k.tokens).padStart(9), k.cost.toFixed(2).padStart(8),
        (k.cost / k.runs).toFixed(3).padStart(7), (k.tools / k.runs).toFixed(1).padStart(10), (k.tools ? (100 * k.errors / k.tools).toFixed(0) : '0').padStart(5), fmt(k.promptTokens / k.runs).padStart(11));
    }
    console.log('\nTOP DESTINATIONS (where tool calls go)');
    for (const d of s.dests.slice(0, 20)) {
      console.log('  ' + d.dest.slice(0, 40).padEnd(40), String(d.count).padStart(6) + ' calls', ('~' + fmt(d.resultTokens) + ' tok returned').padStart(20), d.errors ? `  ${d.errors} err` : '');
    }
    break;
  }
  case 'statusline': {
    // Claude Code pipes session JSON on stdin (includes transcript_path).
    let input = '';
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(input || '{}');
        const tp = j.transcript_path;
        if (!tp || !fs.existsSync(tp)) { console.log('nex-trace: no transcript'); return; }
        const run = parseTranscript(tp);
        const subDir = path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents');
        const subs = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => parseTranscript(path.join(subDir, f))) : [];
        const all = [run, ...subs].flatMap((r) => r.calls);
        const tok = all.reduce((s, c) => s + c.ctx + c.out, 0);
        const cost = all.reduce((s, c) => s + c.cost, 0);
        const last = run.calls[run.calls.length - 1];
        const skill = last && last.inv != null ? run.invocations[last.inv].skill : null;
        const skills = [...new Set(run.invocations.map((i) => i.skill))];
        const ctx = last ? last.ctx : 0;
        console.log(`${skill ? '⚡' + skill + ' · ' : ''}ctx ${fmt(ctx)} · ${fmt(tok)} tok · ~$${cost.toFixed(2)} · ${run.tools.length} tools${subs.length ? ` · ${subs.length} sub` : ''}${skills.length ? ` · skills: ${skills.join(',')}` : ''}`);
      } catch (e) { console.log('nex-trace: ' + e.message); }
    });
    break;
  }
  default:
    console.log('usage: nex-trace [serve|build|json|report|statusline] [--dir DIR] [--days N] [--port P] [--out FILE]');
    process.exit(1);
}
