/**
 * 每日 × 模型的 token 台账（2026-10-31）。
 *
 * ## 为什么要探针
 *
 * 这是"钱账"：数字错了不会报错，只会让人以为某天没用量、或者用量被算重。
 * 三件事最容易被写错，所以钉死：
 *
 *   1. **失败不等于消耗**：失败流通常没有 usage，只记 attempts/errors，不加 token；
 *   2. **缓存读单列**：本项目缓存读能到输入的 10 倍量级，混进 input 就废了；
 *   3. **本地切天**：用 UTC 的话，晚上 8 点后的用量会记到"明天"。
 *
 * 另外钉住 180 天保留期：只删自己写的 `YYYY-MM-DD.json`，别的一概不碰。
 *
 * 用法：node probes/verify-usage-ledger.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const home = mkdtempSync(join(tmpdir(), "mp-usage-"));
process.env.DSH_HOME = home;

// js-yaml 在本仓库没有依赖，探针只需要它的导出名存在（台账路径不碰 YAML）
const stubDir = mkdtempSync(join(tmpdir(), "mp-usage-stub-"));
const map = {};
const put = (spec, body) => {
	const file = join(stubDir, spec.replace(/[^a-z0-9]/gi, "_") + ".mjs");
	writeFileSync(file, body);
	map[spec] = file;
};
put("js-yaml", "export const load = () => ({});\nexport const DEFAULT_SCHEMA = { explicit: [] };\nexport class Schema {}\nexport class Type {}\nexport default {};");
const loader = join(stubDir, "loader.mjs");
writeFileSync(loader, `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(map)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`);
const { register } = await import("node:module");
register(pathToFileURL(loader).href, import.meta.url);

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const mod = await import(pathToFileURL(join(REPO, "dist", "index.js")).href);
const record = mod.__recordPoolUsage;
const flush = mod.__flushUsage;
const report = mod.__usageReport;
const dayKey = mod.__usageDayKey;
for (const [name, fn] of Object.entries({ record, flush, report, dayKey })) {
	assert.equal(typeof fn, "function", `dist/index.js 应导出 __${name}`);
}

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

const usageDir = join(home, "model-pool", "usage");
const today = dayKey();

// 保留期用的旧文件要在**第一次记账之前**放好：剪枝每天只跑一次
mkdirSync(usageDir, { recursive: true });
const oldDate = new Date();
oldDate.setDate(oldDate.getDate() - 200);
const oldKey = dayKey(oldDate);
writeFileSync(join(usageDir, `${oldKey}.json`), JSON.stringify({ schema: "model-pool/usage/v1", day: oldKey, entries: {} }));
writeFileSync(join(usageDir, "别删我.txt"), "x");

console.log("模型池 token 台账");

// 1+2. 成功与失败各一次；失败那次没有 usage
{
	const first = record({
		entry: "qoder/DeepSeek-Flash",
		provider: "qoder",
		model: "DeepSeek-Flash",
		scheme: "纯deepseek",
		usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 },
		ok: true
	});
	const second = record({ entry: "qoder/DeepSeek-Flash", provider: "qoder", model: "DeepSeek-Flash", scheme: "纯deepseek", usage: void 0, ok: false });
	ok("尝试记了两次", second.attempts === 2, JSON.stringify(second));
	ok("成功/失败分开计", second.requests === 1 && second.errors === 1, JSON.stringify(second));
	ok("失败那次不补 token", second.uncachedInputTokens === 1000 && second.outputTokens === 200, JSON.stringify(second));
	ok("缓存读单列", second.cacheReadTokens === 5000 && second.uncachedInputTokens === 1000, JSON.stringify(second));
	ok("缓存写缺省不写脏值", second.cacheWriteTokens === 0);
	ok("记下方案维度（不分组）", second.scheme === "纯deepseek");
	ok("记下时段", /^\d{2}:\d{2}$/.test(first.firstAt) && /^\d{2}:\d{2}$/.test(first.lastAt), JSON.stringify([first.firstAt, first.lastAt]));
	void first;
}

// 3. 另一个模型独立记
{
	record({ entry: "workbuddy4/deepseek-v4.1-flash", provider: "workbuddy4", model: "deepseek-v4.1-flash", scheme: "纯deepseek", usage: { inputTokens: 300, outputTokens: 50 }, ok: true });
	flush();
	const doc = JSON.parse(readFileSync(join(usageDir, `${today}.json`), "utf8"));
	ok("一天一个文件", existsSync(join(usageDir, `${today}.json`)));
	ok("schema 正确", doc.schema === "model-pool/usage/v1", doc.schema);
	ok("两个模型各一条", Object.keys(doc.entries).length === 2, JSON.stringify(Object.keys(doc.entries)));
	ok("落盘后数字与内存一致", doc.entries["qoder/DeepSeek-Flash"].uncachedInputTokens === 1000);
	ok("缓存读没混进输入", doc.entries["qoder/DeepSeek-Flash"].uncachedInputTokens !== 6000);
}

// 4. 报告：新到旧、长度正确、首项是今天
{
	const days = report(7);
	ok("最近 7 天", days.length === 7, String(days.length));
	ok("首项是今天", days[0].day === today, days[0].day);
	ok("今天带得到条目", Object.keys(days[0].entries).length === 2);
	ok("未来日期不会被算进来", days.every((d) => d.day <= today));
}

// 5. 保留期：200 天前的旧文件在首次记账时被清掉，非日期文件不动
{
	ok("超过 180 天的文件被清掉", !existsSync(join(usageDir, `${oldKey}.json`)));
	ok("不是自己写的文件不动", existsSync(join(usageDir, "别删我.txt")));
}

flush();
rmSync(home, { recursive: true, force: true });
rmSync(stubDir, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
