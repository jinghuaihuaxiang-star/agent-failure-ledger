// 端到端自检：自检脚本自带断言 + 样例跑一遍核对数字。
// 用法：node test/run.mjs   （退出码 0 = 全过）
import { execFileSync } from 'node:child_process';

const SRC = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (file, args) => execFileSync(process.execPath, [SRC + file, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok    ${name}`); };
const fail = (name, detail) => {
  console.error(`  FAIL  ${name}\n        ${detail}`);
  process.exitCode = 1;
};
const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));
const json = (file, args) => JSON.parse(run(file, args));

// ---- 1. 单元自检（规则表 / 判定表本身没退化）----
for (const [file, name] of [
  ['src/classify.mjs', 'classify'],
  ['src/mech.mjs', 'mech'],
]) {
  try {
    const out = run(file, ['--selftest']);
    check(`${name} --selftest`, !/FAIL/i.test(out), out.trim().split('\n').slice(-2).join(' | '));
  } catch (e) {
    fail(`${name} --selftest`, (e.stdout ?? '') + (e.stderr ?? ''));
  }
}

// ---- 2. 分类：样例 20 条的分桶必须与文档一致 ----
const cls = json('src/classify.mjs', ['--in', 'samples/events.sample.jsonl', '--json']);
check('样例共 20 条', cls.total === 20, `total=${cls.total}`);
check('真失败 12 条', cls.counts?.real === 12, `real=${cls.counts?.real}`);
check('噪音桶合计 8 条', ['gate', 'probe', 'idiom', 'killed', 'env']
  .reduce((s, k) => s + (cls.counts?.[k] ?? 0), 0) === 8, JSON.stringify(cls.counts));
check('合成样本无坏行', cls.badLines === 0 && cls.degraded === false, `badLines=${cls.badLines} degraded=${cls.degraded}`);

// ---- 3. 双口径：分母由调用数决定，噪音 = 原始 - 真失败 ----
const led = json('src/ledger.mjs', ['--in', 'samples/events.sample.jsonl', '--calls', '400', '--json']);
const expectRaw = 1000 * 20 / 400;
check('双口径：原始 50.0', Math.abs((led.rawPer1k ?? -1) - expectRaw) < 0.05, `rawPer1k=${led.rawPer1k}`);
check('双口径：真失败 30.0', Math.abs((led.realPer1k ?? -1) - 30) < 0.05, `realPer1k=${led.realPer1k}`);
check('噪音 = 差值 20.0', Math.abs((led.rawPer1k - led.realPer1k) - 20) < 0.05,
  `差值=${led.rawPer1k - led.realPer1k}`);
check('根因聚类非空', Array.isArray(led.causes) && led.causes.length > 0, 'causes 为空');

// ---- 4. 机制量表：三种判定必须都能出现（否则判据退化成单一答案）----
const mech = json('src/mech.mjs', ['--events', 'samples/events.sample.jsonl',
  '--registry', 'samples/mechanisms.sample.jsonl', '--json']);
const items = mech.entries ?? [];
const v = (id) => items.find((i) => i.id === id)?.verdict;
check('M01 生效（前有后无）', v('M01') === 'holding', `M01=${v('M01')}`);
check('M02 前科不足 → unproven', v('M02') === 'unproven', `M02=${v('M02')}`);
check('M03 无根因 → declared', v('M03') === 'declared', `M03=${v('M03')}`);
check('declared 不进主指标', mech.headline === 1, `headline=${mech.headline}`);

// ---- 5. 写入单入口：--peek 只读，必须真读到内容 ----
try {
  const out = run('src/edit-safe.mjs', ['--file', 'README.md', '--peek', '--from', '1']);
  check('edit-safe --peek 读到内容', out.trim().length > 0, 'peek 输出为空');
} catch (e) {
  fail('edit-safe --peek', (e.stdout ?? '') + (e.stderr ?? ''));
}

console.log(`\n${pass} 通过${process.exitCode ? '，有失败' : '，全部通过'}`);
