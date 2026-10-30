#!/usr/bin/env node
// mech.mjs — 「这条机制是不是真的把某类失败压住了」的量表。
//
// 为什么需要它：错误率这个数会不动。实测四周 37.8 → 37.1 → 37.9 / 千步，同一水平；
// 继续盯它就是盯一个不动的指针。而且它测的是「我犯错多不多」，不是「这条路有没有在长东西」。
//
// 但「机制化了多少项」如果靠自己在文档里手数，等于自己给自己发合格证。所以把它变成可核的：
// 一项机制要算**生效**，必须同时满足四条——
//   ① 产物在盘上                    （不是「我记得写过」）
//   ② 探针真跑过                    （空 proof 不算；文件存在不等于它会拦）
//   ③ 落地前 7 天该类真失败 ≥2 次    （没有前科就没有「压住」可言，只能算 declared）
//   ④ 落地后 7 天里一次都没有        （后窗口没满只能是 observing）
//
// 这条量表最容易犯的错是把它变成自我表扬：建了工具就记一笔。所以 declared 单列，
// **永不进主指标**——建了工具 ≠ 压住了失败。
//
// 账本：mechanisms.jsonl，一行一项：
//   { "id":"M01", "ts":"2026-10-28T12:00:00Z", "family":"人话说明压住了什么",
//     "kind":"tool|gate|rule|skill", "artifact":"src/edit-safe.mjs",
//     "causes":["fs-not-read","fs-stale"], "proof":[{"cmd":"node","args":["src/edit-safe.mjs","--selftest"]}],
//     "note":"为什么它能压住" }
//   causes 空数组 = errclass 覆盖不到这类失败 → 只会判 declared
//
// 用法：
//   node src/mech.mjs --events events.jsonl [--registry mechanisms.jsonl] [--window 7] [--json] [--dry]
//   node src/mech.mjs --selftest

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REAL_CAUSES } from './classify.mjs';

// 账本里的 cause 必须是分类器认得的根因：拼错一个字母，机制会永远匹配不到、被判成 unproven，
// 而 unproven 看起来跟「确实没有复发」一样安静
const KNOWN_CAUSES = new Set(REAL_CAUSES.map((c) => c.id));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFY = path.join(HERE, 'classify.mjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); if (i < 0) return null; const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const WIN_DAYS = Number(opt('window') || 7);
if (!Number.isFinite(WIN_DAYS) || WIN_DAYS <= 0) { console.error('--window 必须是正数（天）'); process.exit(2); }
const WIN_MS = WIN_DAYS * 86400000;
const MIN_BEFORE = 2;   // 1 次可能是偶发（换个写法就撞上），2 次才算反复发生
const KINDS = ['tool', 'gate', 'rule', 'skill'];
const now = Date.now();

// ── 判定（纯函数，为了能自检）─────────────────────────────────────────────
// 一个只会回 0 的量表和一个坏掉的量表长得一模一样，所以每个分支都要先被证明能触发。
function judge(e, before, after, afterComplete, artifactExists, proofOk, proofMsg) {
  const lastSig = after.length ? (after[after.length - 1].sig || '') : (before.length ? (before[before.length - 1].sig || '') : '');
  let verdict, why;
  if (!artifactExists) { verdict = 'dead'; why = `产物不存在：${e.artifact}`; }
  else if (proofOk === false) { verdict = 'dead'; why = proofMsg; }
  else if (!e.causes.length) { verdict = 'declared'; why = '无可测根因（分类器覆盖不到这类失败）——只算声明，不算生效'; }
  else if (!e.proof.length) { verdict = 'unproven'; why = '有可测根因但没有探针——没跑过的机制不配说压住了'; }
  else if (before.length < MIN_BEFORE) { verdict = 'unproven'; why = `落地前 ${WIN_DAYS} 天该类真失败只有 ${before.length} 次（要求 ≥${MIN_BEFORE}）——一次可能是偶发，不构成前科`; }
  else if (!afterComplete) { verdict = 'observing'; why = `落地后还不到 ${WIN_DAYS} 天（后窗口内 ${after.length} 次）`; }
  else if (!after.length) { verdict = 'holding'; why = `落地前 ${before.length} 次 → 落地后 ${WIN_DAYS} 天 0 次`; }
  else { verdict = 'leaking'; why = `落地前 ${before.length} 次 → 落地后 ${after.length} 次（没压住，最近：${lastSig}）`; }
  return { verdict, why, lastSig };
}

if (flag('selftest')) {
  const e0 = { id: 'X', artifact: 'a.mjs', causes: ['c'], proof: [{ cmd: 'node', args: ['-e', '0'] }] };
  const rows3 = [{ sig: 's' }, { sig: 's' }, { sig: 's' }];
  const cases = [
    ['产物不存在 → dead', judge(e0, rows3, [], true, false, null, '').verdict, 'dead'],
    ['探针失败 → dead', judge(e0, rows3, [], true, true, false, '探针 x').verdict, 'dead'],
    ['无可测根因 → declared', judge({ ...e0, causes: [] }, rows3, [], true, true, null, '').verdict, 'declared'],
    ['有根因无探针 → unproven', judge({ ...e0, proof: [] }, rows3, [], true, true, null, '').verdict, 'unproven'],
    ['前科只有 1 次 → unproven', judge(e0, rows3.slice(0, MIN_BEFORE - 1), [], true, true, true, '').verdict, 'unproven'],
    ['后窗口未满 → observing', judge(e0, rows3, [], false, true, true, '').verdict, 'observing'],
    ['前有后无 → holding', judge(e0, rows3, [], true, true, true, '').verdict, 'holding'],
    ['前有后又来 → leaking', judge(e0, rows3, rows3.slice(0, 1), true, true, true, '').verdict, 'leaking'],
  ];
  let bad = 0;
  for (const [label, got, want] of cases) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}（实际 ${got}）`);
  }
  console.log(`\nmech 自检 ${cases.length - bad}/${cases.length} 通过`);
  process.exit(bad ? 1 : 0);
}

// ── 1. 读账本 + 机械校验 ─────────────────────────────────────────────────
// 账本坏了不能「跳过坏行继续算」：漏掉一项会让生效数偏低，而错在账本上却表现为「机制没生效」，
// 下一次就会去修本来没坏的机制。
const regOpt = opt('registry');
if (regOpt === true) { console.error('mech: --registry 需要一个文件路径（只写 --registry 会被当成文件名 "true"）'); process.exit(2); }
const REG = path.resolve(String(regOpt || 'mechanisms.jsonl'));
if (!fs.existsSync(REG)) { console.error(`mech: 账本不存在 ${REG}`); process.exit(1); }

const bad = [];
const entries = [];
const seen = new Set();
fs.readFileSync(REG, 'utf8').split('\n').forEach((line, i) => {
  const s = line.trim();
  if (!s || s.startsWith('#')) return;
  const at = `第 ${i + 1} 行`;
  let e;
  try { e = JSON.parse(s); } catch (err) { bad.push(`${at} 不是合法 JSON：${err.message}`); return; }
  if (typeof e.id !== 'string' || !e.id.trim()) bad.push(`${at} 缺 id`);
  else if (seen.has(e.id)) bad.push(`${at} id 重复：${e.id}`);
  else seen.add(e.id);
  const t = Date.parse(e.ts);
  if (!Number.isFinite(t)) bad.push(`${at}（${e.id}）ts 解析不了：${e.ts}`);
  else if (t > now) bad.push(`${at}（${e.id}）ts 在未来：${e.ts}`);
  if (!KINDS.includes(e.kind)) bad.push(`${at}（${e.id}）kind 只能是 ${KINDS.join('/')}`);
  if (typeof e.artifact !== 'string' || !e.artifact.trim()) bad.push(`${at}（${e.id}）缺 artifact`);
  if (!Array.isArray(e.causes)) bad.push(`${at}（${e.id}）causes 必须是数组（无可测前科写 []）`);
  else if (e.causes.some((c) => typeof c !== 'string' || !c.trim())) bad.push(`${at}（${e.id}）causes 里只能是根因字符串（写成单个字符串会被逐字符拆开，匹配就废了）`);
  else for (const c of e.causes) if (!KNOWN_CAUSES.has(c)) bad.push(`${at}（${e.id}）根因「${c}」不在 classify 已知列表里（拼错会让机制永远匹配不到）`);
  if (!Array.isArray(e.proof)) bad.push(`${at}（${e.id}）proof 必须是数组（没有探针也写 []，但那就只会是 declared）`);
  else e.proof.forEach((p, pi) => {
    if (!p || typeof p !== 'object') { bad.push(`${at}（${e.id}）proof[${pi}] 不是对象`); return; }
    if (typeof p.cmd !== 'string' || !p.cmd.trim()) bad.push(`${at}（${e.id}）proof[${pi}] 缺 cmd`);
    if (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string')) bad.push(`${at}（${e.id}）proof[${pi}].args 必须是字符串数组`);
    if (p.expectExit !== undefined && !Number.isInteger(p.expectExit)) bad.push(`${at}（${e.id}）proof[${pi}].expectExit 必须是整数`);
  });
  entries.push({ ...e, t });
});
if (bad.length) {
  console.error('mech: 账本不合格，拒绝出读数（宁可报错也不给一个偏小的数）：');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
if (!entries.length) { console.error('mech: 账本里一条机制都没有'); process.exit(1); }

// ── 2. 一次扫完所有真失败行（别按机制各扫一遍）─────────────────────────
const eventsPath = opt('events');
if (!eventsPath || eventsPath === true) { console.error('mech: 需要 --events <events.jsonl>'); process.exit(2); }
let rows = [];
{
  const since = new Date(Math.min(...entries.map((e) => e.t)) - WIN_MS).toISOString();
  let out;
  try {
    out = execFileSync(process.execPath, [CLASSIFY, '--in', String(eventsPath), '--dump', 'all', '--strict'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const tail = String((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(-3).join(' / ');
    console.error(`mech: classify 不可用（exit ${e.status}）：${tail.slice(0, 300)}`);
    process.exit(2);
  }
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (!s.startsWith('{')) { console.error(`mech: classify 输出里有非 JSON 行，读数不可信：${s.slice(0, 100)}`); process.exit(2); }
    let r;
    try { r = JSON.parse(s); } catch { console.error(`mech: classify 输出了不合法的 JSON 行：${s.slice(0, 100)}`); process.exit(2); }
    // classify 与 mech 必须同版本：缺 causeAny 时匹配会全部落空，读数会整体偏向 unproven／holding
    if (!('causeAny' in r)) { console.error('mech: classify 输出里没有 causeAny 字段（版本不匹配），拒绝出读数'); process.exit(2); }
    // 不再只收 real 桶：降桶是分类器的判断，被审对象不该继承它的错误（匹配见第 3 步的 causeAny）
    if (r.at >= Date.parse(since)) rows.push(r);
  }
}
if (!rows.length) { console.error('mech: 窗口内没有读到任何真失败行——这不代表「都压住了」，先查分类器能不能读到事件'); process.exit(2); }

// ── 3. 逐项判定 ─────────────────────────────────────────────────────────
const ROOT = process.cwd();
const results = [];
for (const e of entries) {
  const artifactExists = fs.existsSync(path.isAbsolute(e.artifact) ? e.artifact : path.join(ROOT, e.artifact));
  let proofOk = null, proofMsg = '';
  if (e.proof.length) {
    proofOk = true;
    for (const p of e.proof) {
      const want = Number.isInteger(p.expectExit) ? p.expectExit : 0;
      try {
        execFileSync(p.cmd, p.args || [], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        if (want !== 0) { proofOk = false; proofMsg = `探针 ${p.cmd} 应回 ${want} 实际 0`; break; }
      } catch (err) {
        // 信号 / 超时 / 拿不到整数退出码 = 探针没真正跑完：这时不论账本里写的是什么期望值都不算通过
        if (err.signal || err.killed || !Number.isInteger(err.status)) {
          proofOk = false;
          proofMsg = `探针 ${p.cmd} 没跑完（${err.signal ? 'signal ' + err.signal : err.killed ? '被终止' : '无退出码'}）`;
          break;
        }
        if (err.status !== want) { proofOk = false; proofMsg = `探针 ${p.cmd} exit ${err.status}（期望 ${want}）`; break; }
      }
    }
  }
  // 匹配用 causeAny：分类器给每一行都算的原始证据。只用 real 桶的 cause 时，
  // 一类失败被宽规则误降桶后，机制会凭空「压住了」——分类器的错不该记在被审对象头上
  const mine = e.causes.length ? rows.filter((r) => e.causes.includes(r.causeAny || 'unclassified')) : [];
  const suspect = mine.filter((r) => r.bucket !== 'real').length;
  const before = mine.filter((r) => r.at >= e.t - WIN_MS && r.at < e.t);
  const after = mine.filter((r) => r.at >= e.t && r.at < e.t + WIN_MS);
  const j = judge(e, before, after, now >= e.t + WIN_MS, artifactExists, proofOk, proofMsg);
  results.push({
    id: e.id, family: e.family, kind: e.kind, artifact: e.artifact, causes: e.causes,
    verdict: j.verdict,
    why: j.why + (suspect ? `（另有 ${suspect} 条被降桶但证据吻合，已计入）` : ''),
    beforeN: before.length, afterN: after.length, suspectN: suspect,
  });
}

const ORDER = ['dead', 'leaking', 'holding', 'observing', 'unproven', 'declared'];
const counts = Object.fromEntries(ORDER.map((k) => [k, 0]));
for (const r of results) counts[r.verdict]++;
const summary = {
  ok: true, windowDays: WIN_DAYS, asOf: new Date(now).toISOString(),
  registry: results.length, headline: counts.holding, counts,
  entries: [...results].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.id.localeCompare(b.id)),
};

if (flag('json')) { console.log(JSON.stringify(summary)); process.exit(0); }

const LBL = { dead: '失效', leaking: '漏了', holding: '生效', observing: '观察中', unproven: '无前科', declared: '仅声明' };
console.log(`机制量表 窗口 ${WIN_DAYS} 天 / 账本 ${results.length} 项 / 有证据生效 ${counts.holding} 项`);
for (const k of ORDER) if (counts[k]) console.log(`  ${LBL[k]}  ${counts[k]}`);
console.log('');
for (const r of summary.entries) {
  console.log(`${LBL[r.verdict]}  ${r.id.padEnd(5)} ${r.kind.padEnd(5)} ${r.family}`);
  console.log(`        ${r.why}`);
}
console.log('');
console.log(`判据：产物在盘 + 探针真跑过 + 落地前 ≥${MIN_BEFORE} 次 + 落地后窗口内 0 次 = 生效（数据不干净时整个量表不可用）。`);
console.log('declared 永不进主指标：建了工具 ≠ 压住了失败。');
