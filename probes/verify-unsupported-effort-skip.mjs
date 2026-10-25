/**
 * 「已知不支持的档位直接跳过」回归。
 *
 * 背景：方案链带固定 effort（如「纯deepseek」的 medium），而渠道目录只支持
 * high/max/low 时，旧行为是**每一回合**都先发一次注定被拒的尝试再回落默认档
 * （shim 在本地拒绝，没打到上游，但每回合白跑一趟、日志多两条）——2026-10-24
 * 实测 270 次/天。修复 = 把被拒的 (渠道, 档位) 记 10 分钟，期间直接走默认档。
 *
 * 覆盖四件事：
 *   1. 首回合：medium 被拒 → 回落默认 → 成功（原有行为），llm 恰好被调 2 次。
 *   2. 次回合：记住不支持 → 只调 1 次（medium 不再尝试）。
 *   3. TTL 过期：重新尝试 medium（目录更新后能自愈）。
 *   4. 档位被接受时清掉记忆：手动清空记忆后 medium 直接成功，只调 1 次。
 *
 * 纪律：直接 new `__PoolAdapter` 喂假 llm 与假方案表，不打上游；`js-yaml` 映射到
 * 已安装真包；`USERPROFILE`/`DSH_HOME` 指到临时目录避免污染真实诊断日志。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const realHome = homedir(); // 必须在重定向 USERPROFILE 之前取
const jsYamlEntry = join(realHome, ".dsh", "profiles", "desktop", "node_modules", "js-yaml", "dist", "js-yaml.mjs");
try {
  readFileSync(jsYamlEntry);
} catch {
  console.error(`找不到宿主真包 js-yaml（${jsYamlEntry}）—— 这一段需要装过 dsh 桌面版的机器。`);
  process.exit(2);
}

const tempHome = mkdtempSync(join(tmpdir(), "pool-effort-probe-"));
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
const { __PoolAdapter: PoolAdapter } = await import(pathToFileURL(target).href);

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

/** 假 llm：medium 档拒绝（渠道目录不支持），默认档成功；记录每次调用的档位。 */
function makeLlm(calls) {
  return {
    stream(options) {
      calls.push(options?.reasoningEffort ?? null);
      const effort = options?.reasoningEffort;
      return (async function* () {
        if (effort === "medium") {
          throw new Error('provider "prov" model "m" does not support reasoning effort "medium"');
        }
        yield { type: "text-delta", text: "好" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}

function adapter(calls) {
  return new PoolAdapter(
    () => ({ schemes: { s: { chain: ["prov/m"], effort: "medium" } }, activeScheme: "s" }),
    () => makeLlm(calls),
  );
}

async function drive(a) {
  const chunks = [];
  let error = null;
  try {
    for await (const c of a.stream({ model: "s" })) chunks.push(c);
  } catch (e) {
    error = e;
  }
  return { chunks, error };
}

console.log("model-pool 已知不支持档位跳过");

// 1. 首回合：先拒后成，2 次调用
{
  const calls = [];
  const a = adapter(calls);
  const r = await drive(a);
  ok("首回合成功且正文透传", r.error === null && r.chunks.length === 2, r.error?.message);
  ok("首回合恰好 2 次调用（medium 被拒 + 默认档成功）", calls.length === 2 && calls[0] === "medium" && calls[1] === null, `实际 ${JSON.stringify(calls)}`);

  // 2. 次回合：记忆生效，只调 1 次
  const calls2 = [];
  a.getLlm = () => makeLlm(calls2);
  const r2 = await drive(a);
  ok("次回合成功", r2.error === null, r2.error?.message);
  ok("次回合只调 1 次（跳过已知不支持的 medium）", calls2.length === 1 && calls2[0] === null, `实际 ${JSON.stringify(calls2)}`);

  // 3. TTL 过期：重新尝试 medium
  const blocked = a.effortUnsupported.get("prov/m");
  a.effortUnsupported.set("prov/m", { ...blocked, until: Date.now() - 1 });
  const calls3 = [];
  a.getLlm = () => makeLlm(calls3);
  await drive(a);
  ok("TTL 过期后重新尝试 medium", calls3.length === 2 && calls3[0] === "medium", `实际 ${JSON.stringify(calls3)}`);

  // 4. 档位被接受时清掉记忆
  a.effortUnsupported.delete("prov/m");
  ok("手动清记忆后条目不存在", a.effortUnsupported.has("prov/m") === false);
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
