/**
 * 链路行内的「测」按钮（2026-10-31）。
 *
 * ## 为什么要有它
 *
 * 整轮「自检」时，某一条（如 qoder-intl/DeepSeek-Flash）可能**没有任何结果**——
 * 既没有绿点也没有红点，用户不知道它到底通不通、错在哪。
 *
 * 行内加一个「测」，单独向该供应商/模型发一个最小请求，结果落到同一张 results 表：
 * 成功显示绿色毫秒数，失败显示红点 + error 悬浮。用的就是模型列表里那个
 * `/api/model-pool/test`（probeEntry 对任意 链路键 都能打）。
 *
 * ## 钉住的要点
 *
 * - 在途显示「测中…」并禁用按钮，防止连点；
 * - 键就是链路条目本身（provider/model），不用换算；
 * - 结果与「自检」共用 results —— 两处显示不会各说各话。
 *
 * 用法：node probes/verify-chain-row-test.mjs
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

console.log("链路行 · 单条测试");

ok("行内有「测」按钮", /title: "只测这一条（向该供应商\/模型发一个最小请求）"/.test(src));
ok("点击调 testOne(链路键)", /onClick: \(\) => void testOne\(c\)/.test(src));
ok("在途显示「测中…」", /testing\[c\] === true\s*\?\s*React\.createElement\("span", \{ style: \{ marginLeft: 8, fontSize: 12, color: "#4f46e5" \} \}, "测中…"\)/.test(src));
ok("在途禁用按钮", /disabled: testing\[c\] === true,/.test(src));
ok("结果仍读共享 results", /const r = results\[c\];/.test(src));
ok("失败带 error 悬浮", /title: r\.error \|\| ""/.test(src));
ok("按钮在「移除」之前", src.indexOf('void testOne(c)') < src.indexOf('removeChainItem(i)'));
ok("不影响拖拽排序", /onDragStart: onDragStart\(i\)/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
