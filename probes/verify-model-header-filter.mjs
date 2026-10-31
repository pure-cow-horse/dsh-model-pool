/**
 * 表头筛选（每列单选）+ 列内排序（2026-10-31）。
 *
 * ## 形态
 *
 * 点表头（供应商 / 族 / 免费 / 状态）弹出面板：选一个值 → 该列按此筛选；再点同一个值 → 取消。
 * 面板底部还能对该列升序 / 降序 / 清除。列与列之间**组合**（例如 族=DeepSeek 且 免费=是）。
 *
 * ## 三条最容易写错的地方
 *
 * 1. **计数要忽略本列**：统计「免费」各选项多少行时，若把该列自己的条件也算进去，
 *    选中「是」之后「—」「?」全变 0，用户会以为数据丢了。
 * 2. **筛选判据必须和列里显示的同一套**：免费列渲染的是
 *    `m.free ? "是" : m.configured ? "—" : "?"`，筛选用 `free/paid/unknown` 三键，
 *    两处若不同步，就会出现「筛了免费却混进问号行」。
 * 3. **顶部不能留第二套入口**：旧的 select 已删，残留会变成两个筛选源。
 *
 * 用法：node probes/verify-model-header-filter.mjs
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

console.log("模型列表 · 表头筛选与排序");

// 状态：每列一个标量
ok("columnFilters 是标量（单选）", /useState\(\{ provider: null, family: null, free: null, status: null \}\)/.test(src));
ok("有排序状态", /const \[sortBy, setSortBy\] = useState\(\{ key: null, desc: false \}\)/.test(src));

// 表头
ok("四个可筛表头都接上 filterHeader", ["provider", "family", "free", "status"].every((c) => src.includes(`filterHeader("${c}")`)));
ok("模型列保持普通表头", /React\.createElement\("th", \{ style: styles\.th \}, "模型"\)/.test(src));
ok("表头有激活态高亮", /color: active \? "#4f46e5" : void 0/.test(src));

// 单选语义：再点同一个值取消
ok("再点同一值取消该列", /prev\[col\] === value \? null : value/.test(src));
ok("面板里有「全部」恢复项", /\}, "全部"\)/.test(src));

// 组合筛选：遍历所有列（AND）
ok("passesFilter 遍历所有列（列间 AND）", /for \(const \[col, val\] of Object\.entries\(columnFilters\)\)/.test(src));
ok("按标量严格相等比较", /if \(columnValueOf\(m, col\) !== val\) return false;/.test(src));

// 计数忽略本列
ok("选项计数忽略本列条件", /if \(!passesFilter\(m, col\)\) continue;/.test(src));
ok("选中但 0 条的选项仍保留", /if \(picked !== null && !counts\.has\(picked\)\) counts\.set\(picked, 0\)/.test(src));

// 免费三态与列渲染一致
ok("免费三键映射", /free: "是", paid: "—", unknown: "\?"/.test(src));
ok("列渲染仍是同一套三元", /m\.free \? "是" : m\.configured \? "—" : "\?"/.test(src));

// 排序
ok("有比较函数", /const compareModels = \(a, b, sort\) =>/.test(src));
ok("枚举列按档位排序", /SORT_RANK = \{ free: \{ free: 0, unknown: 1, paid: 2 \}, status: \{ ok: 0, fail: 1, pending: 2 \} \}/.test(src));
ok("面板有升序/降序按钮", /"升序 ↑"/.test(src) && /"降序 ↓"/.test(src));
ok("排序结果落到 filtered", /filtered\.sort\(\(a, b\) => compareModels\(a, b, sortBy\)\)/.test(src));

// 旧入口必须彻底消失
ok("没有旧的 filter 状态", /const \[filter, setFilter\]/.test(src) === false);
ok("没有旧的 filterVal", /filterVal/.test(src) === false);
ok("没有残留「按模型族」下拉", /按模型族/.test(src) === false);

// 兜底体验
ok("有当前筛选小结", /当前筛选/.test(src) === false ? /COLUMN_LABEL\[col\]} · \$\{valueLabel/.test(src) : true);
ok("有一键清除全部", /const clearAll = \(\) =>/.test(src));
ok("筛到 0 条有提示", /没有符合条件的模型/.test(src));
ok("点面板外可关闭", /position: "fixed", inset: 0, zIndex: 40/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
