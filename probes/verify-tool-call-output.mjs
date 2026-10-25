/**
 * 「有产出」判定回归：纯工具调用的回合不能被判成空流。
 *
 * 背景：`_attemptStream` 在流结束时若没见过"产出"就抛
 * `返回空流（无可见正文）`，并把渠道冷却 1 分钟。旧判定只认正文文本
 * （`text-delta` / `block-end(type=text)`），于是**只发起工具调用、不带开场白**
 * 的合法 agent 回合被误判，渠道被顺延——2026-10-24 实测一天 728 次，
 * qoder-cn 63 次、workbuddy4 121 次、trae 33 次，且用户看到的只是"渠道用不了"。
 *
 * 覆盖六件事：
 *   1. 正文文本仍算产出（原有行为不回归）。
 *   2. `tool-call-delta`（无正文）算产出 ← 本次修复。
 *   3. `block-end` + `block.type === "tool-call"`（无正文）算产出。
 *   4. 只有 `reasoning-delta` **仍不算**产出——只在思考中出字的渠道必须继续判失败，
 *      否则用户会拿到一个没有答案的"成功"回合。
 *   5. 全空流、错误 finish 无产出：继续抛，错误文案不变。
 *   6. 产出块原样透传，一个不丢。
 *
 * 纪律：直接 new `__PoolAdapter` 喂假 llm，不打上游；`js-yaml` 按裸标识符映射到
 * 已安装的真包，因此不需要额外命令行开关；`USERPROFILE`/`DSH_HOME` 指到临时目录，
 * 避免探针污染真实诊断日志。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const realHome = homedir(); // 必须在重定向 USERPROFILE 之前取：js-yaml 在真实 profile 里
const jsYamlEntry = join(realHome, ".dsh", "profiles", "desktop", "node_modules", "js-yaml", "dist", "js-yaml.mjs");
try {
  await import(pathToFileURL(jsYamlEntry).href);
} catch {
  console.error(`找不到宿主真包 js-yaml（${jsYamlEntry}）—— 这一段需要装过 dsh 桌面版的机器。`);
  process.exit(2);
}

// 临时家目录：dist/index.js 顶层会往 ~/.dsh/model-pool-diag.log 追加一行加载诊断，
// 探针不该往真实日志里写。
const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-home-"));
const savedUserProfile = process.env.USERPROFILE;
const savedHome = process.env.HOME;
const savedDshHome = process.env.DSH_HOME;
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.DSH_HOME = tempHome;

const loaderFile = join(tempHome, "js-yaml-loader.mjs");
writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nexport async function resolve(s,c,n){ if(s==="js-yaml") return {url:pathToFileURL(${JSON.stringify(jsYamlEntry)}).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
register(pathToFileURL(loaderFile).href, import.meta.url);

const target =
  process.env.POOL_PROBE_TARGET === "installed"
    ? join(realHome, ".dsh", "profiles", "desktop", "node_modules", "dsh-model-pool", "dist", "index.js")
    : join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "index.js");
const { __PoolAdapter } = await import(pathToFileURL(target).href);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail === undefined ? "" : `\n      ${detail}`}`);
  }
};

/** 假 llm：stream() 返回逐个吐 chunks 的 async iterable */
function fakeLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

async function run(chunks) {
  const adapter = new __PoolAdapter(() => ({}), () => fakeLlm(chunks));
  const attempt = { ok: false };
  const out = [];
  let error = null;
  try {
    for await (const ch of adapter._attemptStream({ entry: "probe/m", provider: "probe", model: "m" }, {}, "", attempt, "scheme", Date.now())) {
      out.push(ch);
    }
  } catch (e) {
    error = e;
  }
  return { out, error, attempt };
}

console.log("model-pool 有产出判定");

// 1. 正文文本：原有行为
{
  const r = await run([{ type: "text-delta", text: "你好" }, { type: "finish", reason: { kind: "stop" } }]);
  ok("正文文本不抛（原有行为）", r.error === null && r.out.length === 2);
}

// 2. 纯工具调用：本次修复
{
  const r = await run([
    { type: "tool-call-delta", id: "t1", name: "read_file", argumentsDelta: '{"path"' },
    { type: "finish", reason: { kind: "tool_calls" } },
  ]);
  ok("纯 tool-call-delta 不再被判空流", r.error === null, r.error?.message);
  ok("工具调用块原样透传", r.out.length === 2 && r.out[0].id === "t1");
  ok("attempt 标记为成功", r.attempt.ok === true);
}

// 3. 块收尾的工具调用
{
  const r = await run([
    { type: "block-end", block: { type: "tool-call", id: "t2", name: "read_file", arguments: '{"path":"a"}' } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  ok("block-end(tool-call) 不再被判空流", r.error === null, r.error?.message);
}

// 4. 只有思考：必须继续算失败
{
  const r = await run([{ type: "reasoning-delta", text: "让我想想" }, { type: "finish", reason: { kind: "stop" } }]);
  ok("纯 reasoning-delta 仍判空流（不产生假成功）", r.error !== null && /返回空流（无可见正文）/.test(r.error.message), r.error?.message);
}

// 5. 全空流
{
  const r = await run([{ type: "finish", reason: { kind: "stop" } }]);
  ok("全空流仍判空流", r.error !== null && /返回空流（无可见正文）/.test(r.error.message), r.error?.message);
}

// 6. 错误 finish 且无产出
{
  const r = await run([{ type: "finish", reason: { kind: "error", failure: { code: "QUOTA", message: "429" } } }]);
  ok("错误 finish 无产出仍报无正文错误", r.error !== null && /无正文错误 QUOTA/.test(r.error.message), r.error?.message);
}

if (savedUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = savedUserProfile;
if (savedHome === undefined) delete process.env.HOME;
else process.env.HOME = savedHome;
if (savedDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = savedDshHome;
rmSync(tempHome, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
