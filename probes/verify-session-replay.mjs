/**
 * 会话日志回放：把「直连模型」的用量补回来（2026-10-31）。
 *
 * ## 它补的是什么洞
 *
 * 池子台账只覆盖走 `ModelPool` 的请求。用户直接在模型列表里选某个具体模型时，
 * 宿主绕过池子直发，池子看不见 —— 这部分靠回放会话日志补。
 *
 * ## 三条最容易被写错的口径（这里逐条钉住）
 *
 * 1. **跳过 `ModelPool`**：会话里池子的请求写作 `ModelPool/纯deepseek`（模型位放的是
 *    **方案名**）。不跳过就是把同一笔用量记两遍。
 * 2. **`turn:step` 去重**：`assistant/attempt`（中途快照）与 `assistant/message`
 *    （最终）都可能带 usage，必须覆盖而不是累加。
 * 3. **多帧 zstd**：一个会话文件是多帧拼接，必须按 magic 切帧逐帧解压。
 *
 * 用法：node probes/verify-session-replay.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubDir = mkdtempSync(join(tmpdir(), "replay-stub-"));
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
const fold = mod.__foldSessionText;
const decomp = mod.__decompressSessionBuffer;
assert.equal(typeof fold, "function", "dist/index.js 应导出 __foldSessionText");

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

const T = 1793000000000;
const header = (provider, model) => JSON.stringify({ type: "request/header", time: T, data: { header: { config: { provider, model } } } });
const message = (turn, step, usage) => JSON.stringify({ type: "assistant/message", time: T + turn * 1000, data: { turn, step, usage } });
const attempt = (turn, step, usage) => JSON.stringify({ type: "assistant/attempt", time: T + turn * 1000, data: { turn, step, stream: [{ type: "chunk", chunk: { type: "usage", usage } }, { type: "chunk", chunk: { type: "finish", reason: { kind: "stop" } } }] } });

console.log("会话日志回放");

// 1. 池子的请求必须跳过
{
	const text = [header("ModelPool", "纯deepseek"), message(1, 1, { inputTokens: 100, outputTokens: 10 })].join("\n");
	const records = fold(text, "s1");
	ok("ModelPool 请求不记（池子台账负责）", records.length === 0, JSON.stringify(records));
}

// 2. 直连请求要记
{
	const text = [header("qoder", "DeepSeek-Flash"), message(1, 1, { inputTokens: 100, outputTokens: 10 })].join("\n");
	const records = fold(text, "s1");
	ok("直连请求记一条", records.length === 1, JSON.stringify(records));
	ok("带上 provider/model", records[0]?.provider === "qoder" && records[0]?.model === "DeepSeek-Flash", JSON.stringify(records[0]));
	ok("用量原样保留", records[0]?.usage?.inputTokens === 100 && records[0]?.usage?.outputTokens === 10);
}

// 3. attempt + message 同 step：覆盖不累加
{
	const text = [
		header("trae", "deepseek-v4.1-flash"),
		attempt(1, 1, { inputTokens: 50, outputTokens: 5 }),
		message(1, 1, { inputTokens: 500, outputTokens: 50 })
	].join("\n");
	const records = fold(text, "s1");
	ok("同 turn:step 只留一条", records.length === 1, `条数 ${records.length}`);
	ok("最终值覆盖中途快照", records[0]?.usage?.inputTokens === 500, JSON.stringify(records[0]?.usage));
}

// 4. 不同 step 分开记
{
	const text = [
		header("trae", "x"),
		message(1, 1, { inputTokens: 10, outputTokens: 1 }),
		message(1, 2, { inputTokens: 20, outputTokens: 2 }),
		message(2, 1, { inputTokens: 30, outputTokens: 3 })
	].join("\n");
	ok("三个 step 记三条", fold(text, "s1").length === 3, String(fold(text, "s1").length));
}

// 5. 只有 attempt 也能取到用量
{
	const text = [header("trae", "y"), attempt(1, 1, { inputTokens: 7, outputTokens: 3 })].join("\n");
	const records = fold(text, "s1");
	ok("attempt 里的 usage 也能取到", records[0]?.usage?.inputTokens === 7, JSON.stringify(records[0]));
}

// 6. request/context 也能确立路由；缺路由时标 unknown
{
	const ctxLine = JSON.stringify({ type: "request/context", time: T, data: { provider: "amd", model: "DeepSeek-V4-Flash" } });
	const records = fold([ctxLine, message(1, 1, { inputTokens: 1 })].join("\n"), "s1");
	ok("request/context 提供路由", records[0]?.provider === "amd" && records[0]?.model === "DeepSeek-V4-Flash", JSON.stringify(records[0]));
	const bare = fold([message(1, 1, { inputTokens: 1 })].join("\n"), "s1");
	ok("没有路由时标 unknown 而不是丢记录", bare[0]?.provider === "unknown", JSON.stringify(bare[0]));
}

// 7. 多帧 zstd 拼接
{
	const { zstdCompressSync } = await import("node:zlib");
	const part1 = Buffer.from([header("qoder", "m1"), message(1, 1, { inputTokens: 10 })].join("\n") + "\n");
	const part2 = Buffer.from([message(1, 2, { inputTokens: 20 })].join("\n") + "\n");
	const buffer = Buffer.concat([zstdCompressSync(part1), zstdCompressSync(part2)]);
	const text = decomp(buffer);
	const records = fold(text, "s1");
	ok("两帧都能解出来", text.includes("request/header") && text.includes('"step":2'), `长度 ${text.length}`);
	ok("跨帧合并后记录两条", records.length === 2, String(records.length));
}

// 8. 坏行不炸
{
	const text = ["not json", "{broken", "", header("trae", "z"), message(1, 1, { inputTokens: 5 })].join("\n");
	ok("非 JSON 行被跳过", fold(text, "s1").length === 1);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
