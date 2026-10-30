#!/usr/bin/env node
// edit-safe.mjs — 改「已存在文件」的单入口。把「先读 → 核对版本 → 改 → 回读 → 语法检查」收进一个命令，
// 让这三类结构上不可能发生：
//   · 没先读就改            （工具要求先读）
//   · 读到之后被谁改过       （版本失配）
//   · 锚点不唯一 / 找不到    （改到了别处）
//
// 为什么不用纪律解决：这三类曾经占真失败的 23%，是最单一一类。规则里写「优先用这个工具」
// 压不下去——纪律是对抗自己的注意力，而注意力正是失败的那个东西。只能把入口收窄。
//
// 用法：
//   node src/edit-safe.mjs --file X --old "旧" --new "新" [--all]
//   node src/edit-safe.mjs --file X --spec spec.json        # {"old":"...","new":"...","all":false}
//   node src/edit-safe.mjs --file X --write content.txt     # 整文件覆盖（内容从文件读，避开命令行转义）
//   node src/edit-safe.mjs --file X --peek [--from N --to M]  # 只读：行数 / sha / 区间
// 退出码：0 成功 2 用法错 3 锚点问题 4 写失败 5 回读不一致 6 语法坏（已回滚）
//
// 已知限制（不假装修好）：
//   写前核对 sha 与真正落盘之间仍有微秒级窗口，文件系统没有原子 compare-and-swap，
//   所以本工具不能当多进程并发写同一文件的协调工具。单人单机不会命中；真要并发由调用方串行化。
//   回滚路径已加「检查期间被改过就不回滚」的保护。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes('--' + name);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const readU8 = (p) => fs.readFileSync(p, 'utf8');
const die = (code, obj) => { console.error(JSON.stringify(obj)); process.exit(code); };

const fileArg = opt('file');
if (!fileArg || fileArg === true) die(2, { ok: false, msg: '用法: --file <路径> [--old/--new | --spec | --write | --peek]' });
const FILE = path.resolve(String(fileArg));
if (!fs.existsSync(FILE)) die(2, { ok: false, msg: `文件不存在: ${FILE}` });

// ── 只读模式 ──────────────────────────────────────────────────────────────
if (flag('peek')) {
  const c = readU8(FILE);
  const lines = c.split('\n');
  const base = { ok: true, file: FILE, lines: lines.length, bytes: Buffer.byteLength(c), sha: sha(c) };
  const from = opt('from');
  if (!from || from === true) { console.log(JSON.stringify(base)); process.exit(0); }
  const a = Number(from);
  const b = opt('to') && opt('to') !== true ? Number(opt('to')) : a + 30;
  console.log(JSON.stringify(base));
  for (let i = a; i <= Math.min(b, lines.length); i++) console.log(`${i}: ${lines[i - 1]}`);
  process.exit(0);
}

// ── 原子写：先 tmp + rename，EPERM 时退回原地覆盖 ─────────────────────────
// rename 在 Windows 上遇到「文件刚被 node 执行过 / 被别的进程持着」会 EPERM，
// 而 writeFileSync 原地覆盖通常仍可行。
function writeSafe(p, text) {
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.${path.basename(p)}.ed-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, p);
    return { mode: 'rename' };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp 可能没建出来 */ }
    // 原地覆盖不是原子操作：写到一半失败会把目标留成半截。先把原内容按原始字节留在手上
    // （不经 UTF-8 解码：GBK 编码的文件解码再写回会把字节永久换成替换字符），失败时尽力恢复。
    let bak = null;
    try { bak = fs.readFileSync(p); } catch { /* 目标可能还不存在 */ }
    try {
      fs.writeFileSync(p, text, 'utf8');
    } catch (e2) {
      if (bak !== null) {
        try { fs.writeFileSync(p, bak); } catch (e3) {
          const note = '恢复原内容也失败 ' + (e3.code || e3.message);
          try { e2.message = String(e2.message) + ' | ' + note; } catch { /* message 只读就放弃 */ }
        }
      }
      throw e2;
    }
    return { mode: 'inplace', renameError: e.code || String(e.message) };
  }
}

function verifyReadback(expected) {
  const back = readU8(FILE);
  if (back !== expected) die(5, { ok: false, msg: '回读与写入不一致（磁盘上不是我们写的？）', file: FILE, shaExpected: sha(expected), shaActual: sha(back) });
  return back;
}

async function syntaxCheck(rollback, justWritten) {
  if (!/\.(mjs|cjs|js)$/i.test(FILE)) return 'n/a';
  try {
    // spawnSync 在子进程非零退出时不抛异常（只把状态放 r.status），所以必须自己判：
    // 把 execFileSync 换成 spawnSync 却漏了这一步，真语法错会被当成 ok，回滚分支永不执行。
    const r = spawnSync(process.execPath, ['--check', FILE], { encoding: 'utf8' });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const se = new Error(String(r.stderr || 'node --check 失败').split('\n').filter(Boolean).slice(0, 3).join(' / '));
      se.stderr = String(r.stderr || '');
      throw se;
    }
    return 'ok';
  } catch (e) {
    // 只跳过「沙箱禁止 spawn」；文件系统 EPERM 不能跳过，否则真语法错被静默吞掉
    if (e.code === 'EPERM' && e.syscall === 'spawn') return 'skipped(EPERM)';
    // 语法坏在磁盘上就是坏文件，不能留给下一次会话——自动滚回改前内容再报错。
    // 但只在「磁盘上仍是本次写入的内容」时才滚：否则说明检查期间别人改了它，拿旧内容覆盖就是丢别人的更新。
    let rolledBack = false;
    let concurrent = false;
    let rollbackFailReason = null;
    if (typeof rollback === 'string') {
      try {
        const nowText = readU8(FILE);
        if (typeof justWritten === 'string' && nowText !== justWritten) concurrent = true;
        else { writeSafe(FILE, rollback); rolledBack = true; }
      } catch (e2) {
        rollbackFailReason = e2.code || String(e2.message);
      }
      if (rolledBack) {
        try {
          if (readU8(FILE) !== rollback) { rolledBack = false; rollbackFailReason = 'rollback-verify-mismatch'; }
        } catch (e2) { rolledBack = false; rollbackFailReason = 'rollback-verify-read-fail:' + (e2.code || String(e2.message)); }
      }
    }
    const msg = concurrent
      ? '语法检查失败，且文件在检查期间被其他进程改过——不自动回滚；磁盘上是别人写入的内容（未知），需人工检查'
      : rolledBack ? '语法检查失败，已回滚并回读校验一致'
        : '语法检查失败，回滚未成功——磁盘上留着坏语法文件，需手动修';
    console.error(JSON.stringify({ ok: false, code: 6, msg, file: FILE, rolledBack, concurrent, rollbackFailReason, detail: String(e.stderr || e.message || '').slice(0, 400) }));
    process.exit(6);
  }
}

// ── 提交前提示（误报率最低的两条，只提示不拦截）────────────────────────────
function hints(content) {
  const out = [];
  const abs = content.match(/[A-Za-z]:\\[^\s'"`)]{4,}/g) || [];
  if (abs.length) out.push(`硬编码绝对路径 ${abs.length} 处（换机器 / 换目录即失效）：` + [...new Set(abs)].slice(0, 3).join(' , '));
  const empty = content.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || [];
  if (empty.length) out.push(`空 catch ${empty.length} 处（静默放行家族）：异常被吞，失败看起来像成功`);
  return out;
}

// ── 整文件覆盖 ───────────────────────────────────────────────────────────
const writeSrc = opt('write');
if (writeSrc) {
  if (writeSrc === true || !fs.existsSync(path.resolve(String(writeSrc)))) die(2, { ok: false, msg: '--write 需要一个存在的内容文件路径' });
  const content = readU8(path.resolve(String(writeSrc)));
  const before = readU8(FILE);
  // 读完之后到写入之前别人可能改过它，整文件覆盖一旦落盘就是丢更新。
  const again = readU8(FILE);
  if (again !== before) die(5, { ok: false, msg: '整文件覆盖前发现文件已被改动，放弃写入——重跑一次即基于新内容', file: FILE, shaBefore: sha(before), shaNow: sha(again) });
  let r;
  try { r = writeSafe(FILE, content); } catch (e) { die(4, { ok: false, msg: '整文件覆盖失败（目录只读 / 磁盘满 / 文件被独占）: ' + (e.code || e.message), file: FILE }); }
  verifyReadback(content);
  console.log(JSON.stringify({ ok: true, mode: 'write', file: FILE, bytes: Buffer.byteLength(content), shaBefore: sha(before), shaAfter: sha(content), writeMode: r.mode, syntax: await syntaxCheck(before, content), hints: hints(content) }));
  process.exit(0);
}

// ── 替换 ─────────────────────────────────────────────────────────────────
let oldText, newText, all = flag('all');
const specPath = opt('spec');
if (specPath && specPath !== true) {
  let spec;
  try { spec = JSON.parse(readU8(path.resolve(String(specPath)))); } catch (e) { die(2, { ok: false, msg: '--spec 不是合法 JSON: ' + e.message }); }
  if (typeof spec.old !== 'string' || typeof spec.new !== 'string') die(2, { ok: false, msg: '--spec 需要 {"old":"...","new":"..."}' });
  oldText = spec.old; newText = spec.new; all = all || !!spec.all;
} else {
  const o = opt('old'), n = opt('new');
  if (typeof o !== 'string' || typeof n !== 'string') die(2, { ok: false, msg: '需要 --old 与 --new（多行 / 特殊字符请用 --spec json）' });
  oldText = o; newText = n;
}
if (oldText === '') die(2, { ok: false, msg: '--old 不能为空（整文件覆盖请用 --write）' });

function applyOnce(content) {
  const count = content.split(oldText).length - 1;
  if (count === 0) return { ok: false, code: 3, msg: '锚点找不到（内容里没有这段文本；可能读到的是旧版本，或写错了）' };
  if (count > 1 && !all) return { ok: false, code: 3, msg: `锚点出现 ${count} 次，不唯一——写长一点带上上下文，或加 --all 全替换` };
  // 用函数式替换，避免 newText 里的 $& $1 被当成替换模式
  const next = all ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
  return { ok: true, next, count };
}

// 最多 3 轮：写前一刻内容若被别人改了，就基于新内容重来（自动 rebase）
let last = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  const before = readU8(FILE);
  const shaBefore = sha(before);
  const r = applyOnce(before);
  if (!r.ok) die(r.code, { ok: false, msg: r.msg, file: FILE, sha: shaBefore, bytes: Buffer.byteLength(before) });
  if (sha(readU8(FILE)) !== shaBefore) { last = 'concurrent-modify'; continue; }
  let w;
  try { w = writeSafe(FILE, r.next); } catch (e) { last = e.code || String(e.message); continue; }
  verifyReadback(r.next);
  console.log(JSON.stringify({ ok: true, file: FILE, replaced: r.count, mode: all ? 'all' : 'first', writeMode: w.mode, attempts: attempt, shaBefore, shaAfter: sha(r.next), bytes: Buffer.byteLength(r.next), syntax: await syntaxCheck(before, r.next), hints: hints(r.next) }));
  process.exit(0);
}
die(4, { ok: false, msg: `写入失败，重试 3 次仍不行（最后原因: ${last}）——文件可能被独占，或目录不可写`, file: FILE });
