#!/usr/bin/env node
// ledger.mjs — 从 classify 的输出算「读数」，并做根因聚类。
//
// 这个脚本只做三件事，每件都对应一个曾经骗过我的读数：
//   1) 双口径：原始错误率 vs 真失败率。两者差值就是噪音量——只有一个数的时候，
//      噪音会被当成进步（或退步）。实测：原始 60.6/千步 vs 真失败 38.3/千步，差 37%。
//   2) 每千次调用（而非每千条日志）：分母要稳定，否则「今天查得多」会伪装成「今天错得多」。
//   3) 根因聚类：按「根因 × 形态」分组，看它到底长什么样，而不是只看 top 数字。
//      判「长尾到头」之前必须先看形态——我曾判「到头」，后来加两条规则把未归因从 144 降到 96。
//
// 用法：
//   node src/ledger.mjs --in events.jsonl [--window 7] [--calls 4091] [--top 10] [--cluster ps-gbk-garble]
// --calls 是同窗口内的工具调用总数（没有它就不出「每千次」口径）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUCKETS, LABEL, REAL_CAUSES, wpad } from './classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFY = path.join(HERE, 'classify.mjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); if (i < 0) return null; const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const inPath = opt('in');
if (!inPath || inPath === true) {
  console.error('用法: node src/ledger.mjs --in events.jsonl [--window 7] [--calls N] [--top 10] [--cluster <causeId>]');
  process.exit(2);
}
const win = opt('window');
const calls = Number(opt('calls') || 0);
const top = Number(opt('top') || 8);

// 分类与统计不复制实现：直接调 classify --dump，保证两边永远同一份规则表
let rows = [];
{
  const args = [CLASSIFY, '--in', String(inPath), '--dump', 'all', '--strict'];
  if (win && win !== true) args.push('--window', String(win));
  let out;
  try {
    out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // 读数不完整时不许出表：偏小的分母会把「漏了的失败」看成「压住了」
    const tail = String((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(-3).join(' / ');
    console.error(`ledger: classify 不可用（exit ${e.status}）：${tail.slice(0, 300)}`);
    process.exit(3);
  }
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (!s.startsWith('{')) { console.error(`ledger: classify 输出里有非 JSON 行，读数不可信：${s.slice(0, 100)}`); process.exit(3); }
    rows.push(JSON.parse(s));
  }
}

// ── 1. 分桶 ───────────────────────────────────────────────────────────────
const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
for (const r of rows) counts[r.bucket]++;
const total = rows.length;

// ── 2. 根因聚类 ───────────────────────────────────────────────────────────
const byCause = new Map();
for (const r of rows) {
  if (r.bucket !== 'real') continue;
  const k = r.cause || 'unclassified';
  if (!byCause.has(k)) byCause.set(k, []);
  byCause.get(k).push(r);
}
const causes = [...byCause.entries()].sort((a, b) => b[1].length - a[1].length);

// 「形态」= 报错首行归一化（去掉时间戳、路径、数字），用来区分同一根因下的不同症状
const shape = (r) => String(r.err || '')
  .split('\n').map((s) => s.trim()).find((s) => s && !/^\[stderr\]$/.test(s)) || '(空)'
  .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
  .replace(/\b\d{4,}\b/g, '<n>')
  .slice(0, 110);

// ── 3. 输出 ───────────────────────────────────────────────────────────────
if (flag('json')) {
  console.log(JSON.stringify({
    windowDays: win && win !== true ? Number(win) : null,
    total, calls: calls || null, counts,
    realPer1k: calls ? +(counts.real / calls * 1000).toFixed(1) : null,
    rawPer1k: calls ? +(total / calls * 1000).toFixed(1) : null,
    causes: causes.map(([id, list]) => ({ id, n: list.length })),
  }));
  process.exit(0);
}

console.log(`失败调用 ${total} 条${win && win !== true ? ` / 窗口 ${win} 天` : ''}`);
for (const b of BUCKETS) {
  console.log(`  ${wpad(LABEL[b], 40)} ${String(counts[b]).padStart(4)}`);
}
if (calls) {
  const raw = total / calls * 1000;
  const real = counts.real / calls * 1000;
  console.log(`\n每千次调用：原始错误 ${raw.toFixed(1)} / 真失败 ${real.toFixed(1)}  （差值 ${(raw - real).toFixed(1)} = 噪音）`);
  console.log('两个数必须一起报。只给一个的时候，噪音会被当成进步。');
}

console.log(`\n真失败根因（${counts.real} 条）：`);
for (const [id, list] of causes.slice(0, top)) {
  const pct = counts.real ? (list.length / counts.real * 100).toFixed(0) : '0';
  const def = REAL_CAUSES.find((c) => c.id === id);
  console.log(`  ${String(list.length).padStart(4)}  ${pct.padStart(3)}%  ${id}`);
  if (def) console.log(`             ${String(def.why).split(/[。—]/)[0].slice(0, 90)}`);
}
const un = byCause.get('unclassified')?.length || 0;
if (counts.real) console.log(`\n未归因 ${un} / ${counts.real}（${(un / counts.real * 100).toFixed(0)}%）——这个数大不等于「长尾」，先看形态。`);

// ── 4. 单个根因的形态分布（--cluster <id>）──────────────────────────────
const cl = opt('cluster');
if (cl && cl !== true) {
  const list = byCause.get(String(cl)) || [];
  console.log(`\n根因 ${cl} 的形态（${list.length} 条）：`);
  const shapes = new Map();
  for (const r of list) { const s = shape(r); shapes.set(s, (shapes.get(s) || 0) + 1); }
  for (const [s, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${s}`);
  }
  if (!list.length) console.log('  （这个根因在这份数据里一条都没有）');
}
