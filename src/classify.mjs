#!/usr/bin/env node
// classify.mjs — 把 agent 的失败调用分成 6 个桶，再把「真失败」按根因归因。
//
// 三条设计前提（少一条这套就变成自欺）：
//   1) 非零退出码 ≠ 失败。查了没有、管道早停、检查器按设计判 FAIL、探针验它会不会拒绝——
//      这些都返回非零，算进失败率就会让读数随「我今天查了多少次」而不是「我错了几次」波动。
//   2) fail-closed：没命中任何规则的一律算 real。宁可高估，不给自己免检。
//   3) 归因只回答「下一刀砍哪里」，永不降桶。说不清就是真失败。
//
// 规则表是从一台真实的 agent 工作机上长出来的（Windows + PowerShell 5.1 + 一个自研 harness），
// 每条 why 后面写着它落地时抓到的样本数。换环境时这些规则要按自己的失败形态重写——
// 表本身不是重点，「桶不混、归因不降桶」这个结构才是。
//
// 用法：
//   node src/classify.mjs --in events.jsonl [--window 7] [--json] [--samples top 5]
// 输入：见 docs/02-输入格式.md（一行一个失败调用）

import fs from 'node:fs';
import path from 'node:path';

// ── 分桶规则（顺序即优先级）────────────────────────────────────────────────
const RULES = [
  {
    id: 'killed-minus1',
    bucket: 'killed',
    why: '退出码 4294967295 = -1，进程被终止（超时 / 外部 kill），不是脚本判失败',
    test: (r) => r.tool === 'pwsh' && r.exit === 4294967295,
  },
  {
    id: 'tool-timeout',
    bucket: 'killed',
    why: '工具调用自身超时（tool call timed out after Nms）——不是命令写错，是这一步跑太久被掐断',
    test: (r) => /tool call timed out after \d+/i.test(r.err),
  },
  {
    id: 'killed-text',
    bucket: 'killed',
    why: '正文出现终止标记（SIGKILL / SIGTERM / killed / timeout after）',
    test: (r) => /SIGKILL|SIGTERM|\bKilled\b|was terminated|timeout after \d/i.test(r.err),
  },
  {
    id: 'env-network',
    bucket: 'env',
    why: '传输层失败（网络链路，非命令 / 参数问题）',
    test: (r) => /TRANSPORT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i.test(r.err),
  },
  {
    id: 'env-upstream-5xx',
    bucket: 'env',
    why: '出网失败（fetch failed / other side closed / 上游 HTTP 5xx）——换命令写法过不去；先重试一次再怀疑配置。只认 5xx：4xx 是「这个请求本身不对」，换个参数就能过，归到环境等于免检',
    test: (r) => /TypeError: fetch failed|other side closed|HTTP 5\d\d/i.test(r.err),
  },
  {
    id: 'env-ambiguous-provider',
    bucket: 'env',
    why: '同一能力注册了两个 provider，任何调用都回 ambiguous——配置问题，换写法也过不去',
    test: (r) => /multiple usable .* providers|configure one explicitly/.test(r.err),
  },
  {
    id: 'probe-dry',
    bucket: 'probe',
    why: '显式 dry-run / 负例探针：命令本身就是「验它会不会拒绝」，非零是预期结果',
    test: (r) => /-DryRun\b|--dry-run\b|--dry\b/.test(r.cmd),
  },
  {
    id: 'gate-report',
    bucket: 'gate',
    why: '检查器正常跑完并给出结论（lint / 自检 / 评审闸 / 优化脚本）：缺陷另记在评审与轮次账本，这里重复计会把「已记账的缺陷」算两遍。判据必须看到结论行——只按命令名判，会把闸自己崩溃也当成「报告问题」静默排除',
    test: (r) => /so\.mjs|selftest\.mjs|skills-lint|start-check\.mjs|round\.mjs/.test(r.cmd)
      && /REVIEW (PASS|FAIL)|RESULT: (PASS|FAIL)|PASS \d+\/\d+|错误 \d+ 条/.test(r.out),
  },
  {
    id: 'gate-refused-write',
    bucket: 'gate',
    why: '写入口主动拒绝（锚点找不到 / 不唯一 / 语法坏已回滚）：保护机制生效，不是我把活干错；缺陷细节在工具输出里，重复计会把「工具挡住了我」算成「我改错了」',
    test: (r) => /edit-safe\.mjs|ed\.mjs/.test(r.cmd) && /"ok":false/.test(r.err),
  },
  {
    id: 'gate-guard-block',
    bucket: 'gate',
    why: '宿主层守卫把注定失败的命令形状挡在执行之前（改已存在文件 / 内联 -e / 变量后紧跟冒号 / 解析期语法错），并给出替代写法。保护机制生效，不是失败；这类形状的拦截量应另记一份账，不靠这里复述',
    test: (r) => /BLOCKED by fs-guard|BLOCKED by .*guard/.test(r.err),
  },
  {
    id: 'gate-checker-exit',
    bucket: 'gate',
    why: '命令链里写入口已回 ok:true，退出码来自同一串的评审闸判 FAIL——检查器正常给结论，缺陷另记',
    test: (r) => /"ok":true/.test(String(r.err).slice(0, 60)) && /so\.mjs/.test(r.cmd),
  },
  {
    id: 'by-design-refusal',
    bucket: 'gate',
    why: '工具按设计拒绝（权限档、暂停的目标只能由人恢复、要求顶层人类回合）——不是命令写错，也不是我的失败',
    test: (r) => /cannot resume a paused goal|requires a direct human turn/.test(r.err),
  },
  {
    id: 'interrupt-unknown',
    bucket: 'killed',
    why: '明说「调用已记录但结果没落住」/ wait aborted——进程侧被打断，不是命令语义失败；重试前先看它有没有副作用',
    test: (r) => /interrupted after it was recorded|Error: wait aborted/.test(r.err),
  },
  {
    id: 'ps-early-pipeline',
    bucket: 'idiom',
    why: 'PowerShell 管道早停（`| Select-Object -First N`）：目标命令吐了输出却被掐断，退出码变 1，命令其实干成了。判据要求「有 stdout 且完全无 stderr」——出错打 stderr 的一律不算',
    test: (r) => r.tool === 'pwsh' && r.exit === 1 && !/\[stderr\]/.test(r.err) && String(r.out || '').length > 0
      && /Select-Object\s+-First|Select\s+-First|\|\s*head\b/.test(r.cmd),
  },
  {
    id: 'rg-no-match',
    bucket: 'idiom',
    why: 'rg 无匹配本身返回 1 且不打印任何东西——「查了没有」的负结果，不是命令失败；同样要求无 stderr',
    test: (r) => r.tool === 'pwsh' && r.exit === 1 && !/\[stderr\]/.test(r.err) && String(r.out || '').trim() === ''
      && /(^|[\s;&|(])rg(\s|\.exe)/.test(r.cmd),
  },
  {
    id: 'ps-native-nomatch',
    bucket: 'idiom',
    why: '脚本最后一句是 grep 族（rg / grep / findstr）：exit 1 的唯一含义就是「没匹配到」，错误一律走 stderr。任何 stderr 重定向都会让「无 stderr」失去证据力，所以整段脚本里出现过 `2>` / `*>` 就一律不判',
    test: (r) => {
      if (r.tool !== 'pwsh' || r.exit !== 1 || /\[stderr\]/.test(r.err)) return false;
      const src = String(r.cmdText || r.cmd);
      if (/(\*|2)>/.test(src)) return false;
      const lines = src.split('\n').map((s) => s.trim()).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      return /(^|[\s;&|($])(rg|rg\.exe|grep|findstr)(\s|\.exe|$)/.test(last);
    },
  },
  {
    id: 'ps-cmdlet-nomatch',
    bucket: 'idiom',
    why: '脚本最后一句是 Get-*：没有匹配对象时它写一条非终止错误并把 $? 置假，pwsh 于是 exit 1——「查了没有」，不是代码 bug；带 -ErrorAction SilentlyContinue 的也算在内，所以这条只保证「别当 bug 修」，不保证命令真的成功',
    test: (r) => {
      if (r.tool !== 'pwsh' || r.exit !== 1 || /\[stderr\]/.test(r.err)) return false;
      const src = String(r.cmdText || r.cmd);
      if (/(\*|2)>/.test(src)) return false;
      const lines = src.split('\n').map((s) => s.trim()).filter(Boolean);
      return /^Get-/.test(lines[lines.length - 1] || '');
    },
  },
];

// 中文按 2 字宽算，否则终端里的表全是锯齿
export const wpad = (s, w) => {
  const width = [...s].reduce((a, c) => a + (/[\u1100-\uFFFD]/.test(c) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - width));
};

export const BUCKETS = ['real', 'gate', 'probe', 'idiom', 'killed', 'env'];
export const LABEL = {
  real: '真失败',
  gate: '检查器 / 守卫按设计拒绝（缺陷另记账）',
  probe: '探针 / dry-run（预期非零）',
  idiom: '工具链惯用法（命令干成了，退出码骗人）',
  killed: '进程被终止',
  env: '环境 / 配置（换写法也过不去）',
};

// ── real 桶内部的根因细分 ──────────────────────────────────────────────────
// 桶不变（真失败还是真失败），只为回答「下一刀该砍哪里」。降桶是自欺，归因才是信息。
export const REAL_CAUSES = [
  {
    id: 'fs-not-read',
    why: '改文件之前没读过它——这类不该靠纪律，该把写路径收成单一入口',
    test: (r) => /has not been read|FS_NOT_OBSERVED/i.test(r.err),
  },
  {
    id: 'fs-stale',
    why: '读到之后文件又被改过（含被别的进程重写）——不是内容写错，是版本失配',
    test: (r) => /changed since it was read|FS_STALE_VERSION/i.test(r.err),
  },
  {
    id: 'fs-anchor',
    why: '锚点文本在文件里不唯一或找不到——没带上下文，或读到的是旧版本',
    test: (r) => /matched \d+ times|FS_AMBIGUOUS_EDIT|FS_EDIT_NOT_FOUND|old_string was not found/i.test(r.err),
  },
  {
    id: 'ps-script-error',
    why: '被调用的 .ps1 脚本内部报错（不是外层命令的问题），直接看脚本对应行',
    test: (r) => /powershell\s*:\s*At\s/i.test(r.err),
  },
  {
    id: 'ps-quoting',
    why: '外部命令参数被 PowerShell 拆开（正则里的 | [ ] 被当成管道或转义）——不是那条命令的问题，是调用方式的问题；复杂参数改走 JSON 文件传参，不过 shell 层',
    test: (r) => /unrecognized escape sequence|regex parse error|syntax error, unexpected|文件名、目录名或卷标语法不正确/i.test(r.err),
  },
  {
    id: 'ps-interp',
    why: '变量紧跟冒号（"$x: "）被当成驱动器限定符——要用 ${x}: 或 "$($x):"',
    test: (r) => /变量引用无效|Variable reference is not valid|不能用于指定变量名的字符/i.test(r.err),
  },
  {
    id: 'ps-addtype',
    why: 'Add-Type 内联 C# 编译失败——多为模板里的占位符没替换',
    test: (r) => /Add-Type|\.cs\(\d+\)/.test(r.err),
  },
  {
    id: 'dep-missing',
    why: '依赖前一步的产物（文件 / 进程 / 端口）不存在——时序问题或前置失败，不是这条命令本身错',
    test: (r) => /找不到路径|Cannot find path|No such file|because it does not exist/i.test(r.err),
  },
  {
    id: 'script-self-fail',
    why: '脚本自己判定失败并 exit 1——命令执行成功，业务结论是负结果',
    test: (r) => /没找到|未找到|not found|missing/i.test(r.err),
  },
  {
    id: 'ps-param-name',
    why: '参数名写错或用了歧义缩写：先看该命令的参数表，别凭记忆写',
    test: (r) => /parameter name '[^']+' is ambiguous|parameter cannot be found that matches parameter name|无法处理参数，因为参数名称|找不到与参数名称|具有二义性/i.test(r.err),
  },
  {
    id: 'read-nontext',
    why: '把二进制或 GBK 文件当 UTF-8 文本读——先看魔数或按 gbk 解码',
    test: (r) => /binary file|invalid UTF-8 text/i.test(r.err),
  },
  {
    id: 'tool-arg-nul',
    why: '参数含 NUL 字节或类型不对（spawn 的 EINVAL）——多是「整段脚本当字符串拼」带进了坏字节，改用参数文件',
    test: (r) => /must be a string without null bytes|The argument 'args\[\d+\]' must be/i.test(r.err),
  },
  {
    id: 'ps-regex-escape',
    why: '正则里的转义在命令行层被吃掉（报错文案是中文，英文规则接不住）——正则别写进命令行',
    test: (r) => /正在分析[^"]{0,60}过多|正则表达式中不允许/i.test(r.err),
  },
  {
    id: 'ps-gbk-garble',
    why: 'PowerShell 5.1 的错误文本以 GBK 写出、被按 UTF-8 解码成乱码（U+FFFD 连片）——错误内容既不可读也无法被任何关键词规则匹配，这是「读数不可信」而不只是外观问题。先修输出编码，才看得见它到底说了什么',
    test: (r) => /[\uFFFD]{2,}/.test(r.err),
  },
  {
    id: 'tool-args-missing',
    why: '调工具时漏了必填参数：参数校验层就拒了，命令根本没跑——把必填项补上重发，别去改脚本',
    test: (r) => /invalid arguments: missing required property|missing required property/i.test(r.err),
  },
  {
    id: 'py-traceback',
    why: 'Python 脚本抛异常（Traceback）——看最后一行异常类型与行号，是脚本自身的问题',
    test: (r) => /Traceback \(most recent call last\):?[\s\S]{0,80}File "/.test(r.err),
  },
  {
    id: 'ps-native-error',
    why: '原生命令向 stderr 写了内容，PowerShell 5.1 把它包成 NativeCommandError——先看原生命令自己的 stderr 首行，不要按 PS 语法问题排查',
    test: (r) => /FullyQualifiedErrorId : NativeCommandError/.test(r.err),
  },
  {
    id: 'compress-summary-rejected',
    why: '压缩批次整批被拒（摘要太短 / 长度校验不过）：短摘要会让整批 fold 全失败，摘要必须自足',
    test: (r) => /Compression FAILED|Summary too short/i.test(r.err),
  },
  {
    id: 'inline-eval-mangled',
    why: '`node -e "…"` 的双层引号被 shell 先吃掉，node 收到半截程序——代码落成文件再跑',
    test: (r) => /\[eval\]:\d+/.test(r.err) || (/SyntaxError: Unexpected end of input/.test(r.err) && /node -e/.test(String(r.cmd))),
  },
  {
    id: 'ps-param-type',
    why: '参数类型不对而不是名字不对（-Filter 收到数组）——-Filter 只收单个字符串',
    test: (r) => /System\.Object\[\].{0,12}(转换为参数|to type)|Cannot convert .{0,40}Object\[\]/i.test(r.err),
  },
  {
    id: 'selector-miss',
    why: '选择器在页面上不存在——猜类名会直接失败，先取真实节点清单',
    test: (r) => /did not resolve \(no element matches the selector\)/.test(r.err),
  },
  {
    id: 'rg-io-error',
    why: 'rg 在目标路径上 IO 失败：不是没匹配，是根本没读到（虚拟路径 / 路径不存在）',
    test: (r) => /rg: .*IO error for operation/i.test(r.err),
  },
  {
    id: 'ws-path-refused',
    why: '工具参数越出允许的工作区——文件先落到工作区内再传',
    test: (r) => /must stay inside the .* workspace/i.test(r.err),
  },
  {
    id: 'selftest-fail',
    why: '自检脚本自己报了 FAIL 断言：这是工具缺陷、不是环境问题，先看那一行断言的输入与输出。判据自带乱码排除——乱码时先修编码，才看得见断言说了什么',
    test: (r) => /\bselftest\b/i.test(String(r.cmd)) && /\bFAIL\b/.test(r.err) && !/[\uFFFD]{2,}/.test(r.err),
  },
  {
    id: 'ps-runtime-error',
    why: 'PowerShell 内核判错（有 CategoryInfo 但不是 NativeCommandError）：参数绑定、类型转换、cmdlet 不存在——按错误首行点名的那个 cmdlet 查',
    test: (r) => /CategoryInfo\s*:/.test(r.err) && !/NativeCommandError/.test(r.err),
  },
  {
    id: 'script-crash',
    why: '脚本自身抛未捕获异常（堆栈 / MODULE_NOT_FOUND / line N / <anonymous_script>）：看首个帧的文件与行',
    test: (r) => !/Traceback \(most recent call last\)/.test(r.err)
      && /MODULE_NOT_FOUND|<anonymous_script>:|node:internal\/|file:\/\/\/[A-Za-z]:/.test(r.err),
  },
];

// 归因优先级与定义顺序解耦。为什么需要：新规则追加在数组末尾时会被更早的宽规则抢走——
// 实测「漏必填参数」的 6 条全被 /missing/ 吃掉，乱码行被 /Add-Type/ 误判（长输出里常出现这个词）。
// 顺序原则：命令名 + 字面证据最先（且自带乱码排除）→ 乱码（乱码时其他关键词都不可信）
// → 工具层拒绝（命令根本没跑）→ 越具体越前。
export const CAUSE_ORDER = [
  'selftest-fail', 'ps-gbk-garble', 'tool-args-missing', 'read-nontext', 'ps-param-name',
  'ps-param-type', 'ps-regex-escape', 'compress-summary-rejected', 'inline-eval-mangled',
  'selector-miss', 'rg-io-error', 'ws-path-refused', 'ps-addtype', 'dep-missing',
  'ps-runtime-error', 'script-crash',
];

const byCauseId = new Map(REAL_CAUSES.map((c) => [c.id, c]));

export function pickCause(r) {
  const hit = (c) => { try { return !!c.test(r); } catch { return false; } };
  for (const id of CAUSE_ORDER) { const c = byCauseId.get(id); if (c && hit(c)) return id; }
  for (const c of REAL_CAUSES) { if (!CAUSE_ORDER.includes(c.id) && hit(c)) return c.id; }
  return 'unclassified';
}

export function classify(r) {
  for (const rule of RULES) {
    let hit = false;
    try { hit = !!rule.test(r); } catch { hit = false; }
    if (hit) return { bucket: rule.bucket, rule: rule.id, cause: null };
  }
  // fail-closed：未命中一律算 real，再给一个根因标签，让「下一刀砍哪里」有依据。
  return { bucket: 'real', rule: null, cause: pickCause(r) };
}

// ── 自检：分桶与归因规则不许静默退化 ─────────────────────────────────────
// 规则表全是正则，一条写坏的正则不会报错、只会永远不命中——读数照样「正常」，
// 归因却整体落到 unclassified。合成样本能在退化当场抓住它。
export function selftest() {
  const cases = [
    ['killed', { tool: 'pwsh', exit: 4294967295, cmd: '', out: '', err: '' }],
    ['killed', { tool: 'pwsh', exit: 1, cmd: 'x', out: '', err: 'tool call timed out after 120000ms' }],
    ['env', { tool: 'curl', exit: 28, cmd: 'x', out: '', err: 'TRANSPORT: Connection error.' }],
    ['env', { tool: 'bash', exit: 1, cmd: 'x', out: '', err: 'TypeError: fetch failed' }],
    ['probe', { tool: 'pwsh', exit: 1, cmd: 'install.ps1 --dry-run', out: '', err: 'refused' }],
    ['idiom', { tool: 'pwsh', exit: 1, cmd: 'Get-ChildItem C:\\a | Select-Object -First 3', out: 'a\nb', err: '' }],
    ['idiom', { tool: 'pwsh', exit: 1, cmd: 'rg foo .', out: '', err: '' }],
    ['idiom', { tool: 'pwsh', exit: 1, cmd: 'Get-Process notepad', out: '', err: '' }],
    ['gate', { tool: 'pwsh', exit: 1, cmd: 'node tools/ed.mjs --file a', out: '', err: '{"ok":false,"msg":"锚点找不到"}' }],
    ['real', { tool: 'pwsh', exit: 1, cmd: 'node a.mjs', out: '', err: 'SyntaxError: Unexpected token }' }],
  ];
  let bad = 0;
  for (const [want, row] of cases) {
    const got = classify(row).bucket;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} 期望 ${want} 实际 ${got}   ${String(row.cmd).slice(0, 50)}`);
  }
  // 归因顺序不得被宽规则抢走
  const causeCases = [
    ['ps-gbk-garble', { tool: 'pwsh', exit: 1, cmd: 'x', out: '', err: '错误 \uFFFD\uFFFD\uFFFD' }],
    ['tool-args-missing', { tool: 'pwsh', exit: 1, cmd: 'x', out: '', err: 'invalid arguments: missing required property "description"' }],
    ['fs-stale', { tool: 'edit', exit: 1, cmd: 'x', out: '', err: 'file changed since it was read' }],
  ];
  for (const [want, row] of causeCases) {
    const got = pickCause(row);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} 归因期望 ${want} 实际 ${got}`);
  }
  const total = cases.length + causeCases.length;
  console.log(`\nclassify 自检 ${total - bad}/${total} 通过`);
  return bad === 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf('--' + n); if (i < 0) return null; const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
  const flag = (n) => argv.includes('--' + n);

  if (flag('selftest')) process.exit(selftest() ? 0 : 1);

  const inPath = opt('in');
  if (!inPath || inPath === true) {
    console.error('用法: node src/classify.mjs --in events.jsonl [--window 7] [--json] [--dump all] [--strict]');
    process.exit(2);
  }
  const file = path.resolve(String(inPath));
  if (!fs.existsSync(file)) { console.error(`classify: 找不到 ${file}`); process.exit(2); }

  const winDays = Number(opt('window') || 0);
  const untilMs = Date.now();
  const sinceMs = winDays > 0 ? untilMs - winDays * 86400000 : -Infinity;

  const rows = [];
  let badLines = 0;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    let r;
    try { r = JSON.parse(s); } catch { badLines++; return; }
    const at = Date.parse(r.at || '');
    if (!Number.isFinite(at)) { badLines++; return; }
    if (at < sinceMs || at > untilMs) return;
    const c = classify(r);
    rows.push({ ...r, at, bucket: c.bucket, rule: c.rule, cause: c.cause });
  });

  if (flag('dump')) {
    // 给下游脚本用：一行一行的 JSONL，诊断信息走 stderr，别混进 stdout
    for (const r of rows) console.log(JSON.stringify(r));
    if (badLines && flag('strict')) { console.error(`classify: ${badLines} 行解析不了，读数不完整`); process.exit(3); }
    return;
  }

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const r of rows) counts[r.bucket]++;
  const total = rows.length;
  const sum = BUCKETS.reduce((a, b) => a + counts[b], 0);
  const degraded = badLines > 0 || sum !== total;

  const out = { windowDays: winDays || null, asOf: new Date(untilMs).toISOString(), total, counts, degraded, badLines };
  if (flag('json')) { console.log(JSON.stringify(out)); process.exit(0); }

  console.log(`窗口 ${winDays ? winDays + ' 天' : '全部'} / 失败调用 ${total} 条${degraded ? `  (读数降级: ${badLines} 行解析不了)` : ''}`);
  for (const b of BUCKETS) {
    const pct = total ? (counts[b] / total * 100).toFixed(1) : '0.0';
    console.log(`  ${wpad(LABEL[b], 40)} ${String(counts[b]).padStart(4)}  ${pct.padStart(5)}%`);
  }
  const unclassified = rows.filter((r) => r.cause === 'unclassified').length;
  if (counts.real) {
    console.log(`\n真失败 ${counts.real} 条，其中未归因 ${unclassified} 条（${(unclassified / counts.real * 100).toFixed(0)}%）`);
  }
  console.log('\n桶的总和必须等于条数；对不上说明有调用没被分到任何桶（脚本会标 degraded）。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) main();
