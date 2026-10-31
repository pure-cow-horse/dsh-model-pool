/**
 * 模型列表的两个交互毛病（2026-10-31）。
 *
 * ## 1. 往下拉就没标题栏
 *
 * 表格在 `overflowY: auto` 的容器里，`th` 没有 sticky，滚两屏就不知道哪列是哪列。
 *
 * ## 2. 点「测」没有任何反馈
 *
 * `testOne()` 直接 `await api(...)`，没有 try/catch、没有在途状态：
 *   - 请求慢的时候按钮毫无变化（用户以为没点上，会连点）；
 *   - 接口返回失败或被拒绝时是**未处理的 rejection**，界面上什么都不会发生；
 *   - 结果只写进「状态」列，行一长根本看不见。
 *
 * 修法：`th` 吸顶（collapse 下再补一条 inset 阴影，否则那条分割线会被吃掉）；
 * 点击先置 `testing[key]`（按钮变「测中…」并禁用），失败也写进 `results`，
 * 结果直接贴在按钮右边（`123ms` / `失败`）。
 *
 * 用法：node probes/verify-model-list-ux.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const src = readFileSync(join(REPO, "dist", "client.js"), "utf8");

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
	if (cond) {
		pass += 1;
		console.log(`  \u2713 ${name}`);
	} else {
		fail += 1;
		console.log(`  \u2717 ${name}${detail === undefined ? "" : `\n      ${detail}`}`);
	}
};

console.log("模型列表 · 表头吸顶与测试反馈");

// 表头
ok("th 吸顶", /th: \{[^}]*position: "sticky"/.test(src));
ok("th 有实底（不然内容会从下面透出来）", /th: \{[^}]*background: "#fff"/.test(src));
ok("th 叠了 inset 分割线（collapse 下 border 会消失）", /th: \{[^}]*boxShadow: "inset 0 -1px 0 #eee"/.test(src));

// 在途状态
ok("有 testing 状态", /const \[testing, setTesting\] = useState\(\{\}\)/.test(src));
ok("点击先置位", /setTesting\(\(prev\) => \(\{ \.\.\.prev, \[key\]: true \}\)\)/.test(src));
ok("结束后清理", /delete next\[key\];/.test(src));
ok("按钮在途文案", /testing\[m\.key\] === true \? "测中…" : "测"/.test(src));
ok("在途时禁用按钮", /disabled: testing\[m\.key\] === true/.test(src));

// 失败必须落到界面
ok("testOne 有 try/catch", /const testOne = async \(key\) => \{[\s\S]{0,900}?catch \(error\)/.test(src));
ok("接口 ok:false 也当失败", /j\.ok === false \? \{ status: "fail"/.test(src));
ok("异常写进 results", /status: "fail", error: error instanceof Error/.test(src));

// 结果贴在按钮旁
ok("行内显示耗时", /`\$\{r\.latency\}ms`/.test(src));
ok("行内显示失败（带 error 悬浮）", /title: r\.error \|\| ""/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
