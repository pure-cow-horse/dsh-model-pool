/**
 * 用量页的「来源」筛选（2026-10-31）。
 *
 * 池子行和直连行混在同一张表里，看"直连到底用了多少"只能靠肉眼过滤。
 *
 * 三件事必须对，否则数字会自相矛盾：
 *   1. 筛选后**概览要跟着重算** —— 不能一边显示"只看直连"，一边概览还是全量；
 *   2. 筛选后**逐日要跟着重算**，否则表里只有直连、柱状图还是池子占大头；
 *   3. **对账那行必须始终全量** —— 它是数据完整性的证明，跟着筛选就失去意义。
 *
 * 逻辑活在渲染闭包里，只能静态核查；核查的是"数字到底从哪来"这种点。
 *
 * 用法：node probes/verify-usage-source-filter.mjs
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

console.log("用量页 · 来源筛选");

ok("有筛选状态", /const \[sourceFilter, setSourceFilter\] = useState\("all"\)/.test(src));
ok("三个来源芯片", /\[\["all", "全部"\], \["pool", "池子"\], \["direct", "直连"\]\]/.test(src));
ok("芯片接上 setSourceFilter", /onClick: \(\) => setSourceFilter\(value\)/.test(src));

// 概览与逐日必须从过滤后的 rows 重算
ok("先按来源过滤 rows", /const rows = sourceFilter === "all" \? allRows : allRows\.filter\(\(row\) => row\.source === sourceFilter\)/.test(src));
ok("概览由过滤后的行重算", /const overall = rows\.reduce\(/.test(src));
ok("逐日由过滤后的行重算", /for \(const row of rows\) \{[\s\S]{0,400}?dayMap\.set\(row\.day, bucket\)/.test(src));
ok("按模型表用过滤后的行", /const modelRows = usageModelRows\(rows\)/.test(src));

// 概览不再直接吃接口的 totals（那是全量）
ok("概览不再取 usage.totals.overall", /const overall = usage\.totals\?\.overall/.test(src) === false);

// 对账必须全量
ok("对账合计取池子+直连（全量）", /usage\.reconcile\?\.poolTokens \?\? 0\) \+ \(usage\.reconcile\?\.directTokens/.test(src));
ok("对账行标注不受筛选影响", /数据覆盖（不受筛选影响）/.test(src));

// 导出跟随筛选
ok("导出跟随筛选", /const exportRows = \(usage\.rows \|\| \[\]\)\.filter\(\(row\) => sourceFilter === "all"/.test(src));
ok("导出文件名标注来源", /天\$\{sourceFilter === "all" \? "" : "_"/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
