/**
 * P0-1 / P0-2 回归探针。
 *
 * P0-1：冷却优先采用上游 Retry-After / 429 reset；识别不到时才退回指数退避。
 * P0-2：零候选/全部冷却时，错误必须带冷却原因和上一次真实失败，status().attempts 不被空数组覆盖。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { register } from "node:module";

const realHome = homedir();
const jsYamlEntry = join(realHome, ".dsh", "profiles", "desktop", "node_modules", "js-yaml", "dist", "js-yaml.mjs");
try {
  await import(pathToFileURL(jsYamlEntry).href);
} catch {
  console.error(`找不到宿主真包 js-yaml（${jsYamlEntry}）`);
  process.exit(2);
}

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-p0-"));
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
const mod = await import(pathToFileURL(target).href);
const { __PoolAdapter } = mod;

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

function fakeLlm(failure) {
  return {
    stream() {
      return (async function* () {
        yield { type: "finish", reason: { kind: "error", failure } };
      })();
    },
  };
}

async function consume(adapter, model = "s") {
  try {
    for await (const _ of adapter.stream({ model })) {
      // 消费流
    }
    return null;
  } catch (error) {
    return error;
  }
}

console.log("model-pool P0-1 / P0-2 回归");

// P0-1：上游 reset 文本 / Retry-After / 错误码策略
{
  const adapter = new __PoolAdapter(() => ({ cooldownMs: 60000, maxBackoffMs: 300000 }), () => fakeLlm({}));
  const now = Date.now();

  const reset = adapter._recordFailure("p/m", now, {
    code: "RATE_LIMIT",
    status: 429,
    message: "quota exhausted; resets in 3 hours, 35 minutes",
  });
  ok("429 reset 文本折算为 3h35m 冷却", reset === 12900000, `cooldown=${reset}`);

  const header = adapter._recordFailure("h/m", now, {
    code: "RATE_LIMIT",
    status: 429,
    headers: { "retry-after": "90" },
    message: "slow down",
  });
  ok("Retry-After 90 秒被识别", header === 90000, `cooldown=${header}`);

  const retryField = adapter._recordFailure("r/m", now, { code: "RATE_LIMIT", retryAfter: 120 });
  ok("retryAfter=120 秒被识别", retryField === 120000, `cooldown=${retryField}`);

  const quota = adapter._recordFailure("q/m", now, { code: "QUOTA", status: 429, message: "quota exhausted" });
  ok("无 reset 的 QUOTA 至少冷却 15 分钟", quota === 900000, `cooldown=${quota}`);

  const auth = adapter._recordFailure("a/m", now, { code: "AUTH", status: 401, message: "invalid api key" });
  ok("AUTH 冷却 1 小时", auth === 3600000, `cooldown=${auth}`);

  const exp1 = adapter._recordFailure("e/m", now);
  const exp2 = adapter._recordFailure("e/m", now);
  ok("无错误信息的普通失败仍走 60s -> 120s 指数退避", exp1 === 60000 && exp2 === 120000, `${exp1}/${exp2}`);

  const cooling = adapter.status().cooling.find((item) => item.entry === "p/m");
  ok("status.cooling 标出上游来源与错误码", cooling?.source === "upstream" && cooling?.code === "RATE_LIMIT", JSON.stringify(cooling));
  ok("status.cooling 带 retryAfterMs", cooling?.retryAfterMs === 12900000, String(cooling?.retryAfterMs));
}

// P0-2：第一轮全失败 -> 第二轮零候选，错误不丢、attempts 不被覆盖
{
  const state = { activeScheme: "s", schemes: { s: { chain: ["a/x", "b/y"] } } };
  const adapter = new __PoolAdapter(() => state, () => fakeLlm({
    code: "RATE_LIMIT",
    status: 429,
    message: "quota exhausted; resets in 3 hours, 35 minutes",
  }));

  const first = await consume(adapter);
  ok("第一轮全失败有原始错误", first !== null && /resets in 3 hours, 35 minutes/.test(first.message), first?.message);
  ok("第一次失败后 attempts=2", adapter.status().attempts.length === 2, String(adapter.status().attempts.length));

  const second = await consume(adapter);
  ok("零候选不再抛无信息的兜底文案", second !== null && !/ModelPool: 链上所有渠道均不可用/.test(second.message), second?.message);
  ok("零候选错误码为 ALL_COOLING", second?.code === "ALL_COOLING", String(second?.code));
  ok("零候选错误说明全部在冷却", /全部处于冷却中/.test(second?.message || ""), second?.message);
  ok("零候选错误带上次真实失败", /上次失败/.test(second?.message || "") && /无正文错误/.test(second?.message || ""), second?.message);
  ok("零候选错误带 retryAt", typeof second?.retryAt === "number" && second.retryAt > Date.now(), String(second?.retryAt));
  ok("零候选错误带 attempts=2", Array.isArray(second?.attempts) && second.attempts.length === 2, String(second?.attempts?.length));
  ok("status().attempts 未被空数组覆盖", adapter.status().attempts.length === 2, String(adapter.status().attempts.length));
  ok("status().attemptsAt 保留时间戳", adapter.status().attemptsAt > 0, String(adapter.status().attemptsAt));
}

// P0-2：候选存在但结构性跳过，给 ALL_SKIPPED 而不是空 lastError
{
  const state = { activeScheme: "s", schemes: { s: { chain: ["ghost/m"] } } };
  const adapter = new __PoolAdapter(() => state, () => fakeLlm({}));
  adapter.registered = new Set(["other"]);
  const err = await consume(adapter);
  ok("全部跳过时错误码为 ALL_SKIPPED", err?.code === "ALL_SKIPPED", String(err?.code));
  ok("全部跳过时说明跳过原因", /没有可用候选/.test(err?.message || "") && /宿主未注册/.test(err?.message || ""), err?.message);
  ok("全部跳过时保留 attempts", adapter.status().attempts.length === 1 && adapter.status().attempts[0].skipped === true, String(adapter.status().attempts.length));
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
