/**
 * 模型列表的「免费」筛选（2026-10-31）。
 *
 * 免费列显示的是三态：`是`（免费）/ `—`（已知非免费）/ `?`（上游没声明）。
 * 筛选最怕的是**判据和列里显示的不是同一套** —— 用户选了「仅免费」，表里却混进
 * 一个显示「?」的行，或者显示「是」的行被筛掉，那这个筛选项就是负资产。
 *
 * 所以这里钉住：筛选用的表达式必须与渲染那一格的三元表达式逐字对应。
 *
 * 用法：node probes/verify-model-free-filter.mjs
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

console.log("模型列表 · 免费筛选");

// 三态选项
ok("有「仅免费」", /value: "free" \}, "仅免费"/.test(src));
ok("有「仅非免费」", /value: "paid" \}, "仅非免费"/.test(src));
ok("有「免费未知」", /value: "unknown" \}, "免费未知"/.test(src));

// 判据必须与渲染一致：m.free ? "是" : m.configured ? "—" : "?"
ok("free 只留 m.free === true", /filter === "free" && m\.free !== true/.test(src));
ok("paid 只留「非免费且已配置」", /filter === "paid" && !\(m\.free !== true && m\.configured\)/.test(src));
ok("unknown 只留「非免费且未配置」", /filter === "unknown" && \(m\.free === true \|\| m\.configured\)/.test(src));

// 渲染那一格确实还是同一套三元
ok("列渲染仍是 free/configured 三态", /m\.free \? "是" : m\.configured \? "—" : "\?"/.test(src));

// 二级下拉不能跟着出现（免费三态是自足的）
ok("二级下拉只在按供应商/族时出现", /\(filter === "provider" \|\| filter === "family"\) && React\.createElement\("select"/.test(src));
ok("没有残留 filter !== all 的旧条件", /filter !== "all" && React\.createElement\("select"/.test(src) === false);

// 计数句要在筛选时也变
ok("筛选时也显示「匹配 X / 共 Y」", /q \|\| filter !== "all" \? `匹配 \$\{filtered\.length\}/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
