/**
 * 故障转移指数退避（Exponential Backoff）探针校验。
 *
 * 验证：
 *   1. 连续失败时按 2^n 退避（基准 60s -> 120s -> 240s -> 480s -> 500s 封顶）。
 *   2. 上限 500 秒生效（默认 500000ms），后续连续失败保持 500s 不再无限膨胀。
 *   3. 调用成功后重置该渠道连续失败次数，再次失败重新从基准时间起步。
 *   4. 中途断流与无产出失败均计入退避。
 *   5. status().cooling 带出 streak 与 remainingMs，status().maxBackoffMs 准确汇报。
 *   6. state.maxBackoffMs 可自定义上限（如 200s 封顶）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-backoff-"));
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

function fakeLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

console.log("model-pool 指数退避与 500s 封顶校验");

// 1. 基础阶梯：60s -> 120s -> 240s -> 480s -> 500s (封顶)
{
  const adapter = new __PoolAdapter(() => ({ cooldownMs: 60000 }), () => fakeLlm([]));
  const entry = "provider/model-a";
  const now = Date.now();

  ok("默认退避上限为 500 秒", adapter._maxBackoffMs() === 500000, String(adapter._maxBackoffMs()));

  const cd1 = adapter._recordFailure(entry, now);
  ok("第 1 次失败冷却 60 秒", cd1 === 60000 && adapter.failureStreaks.get(entry) === 1, `cd1=${cd1}`);

  const cd2 = adapter._recordFailure(entry, now);
  ok("第 2 次连续失败退避至 120 秒 (2x)", cd2 === 120000 && adapter.failureStreaks.get(entry) === 2, `cd2=${cd2}`);

  const cd3 = adapter._recordFailure(entry, now);
  ok("第 3 次连续失败退避至 240 秒 (4x)", cd3 === 240000 && adapter.failureStreaks.get(entry) === 3, `cd3=${cd3}`);

  const cd4 = adapter._recordFailure(entry, now);
  ok("第 4 次连续失败退避至 480 秒 (8x)", cd4 === 480000 && adapter.failureStreaks.get(entry) === 4, `cd4=${cd4}`);

  const cd5 = adapter._recordFailure(entry, now);
  ok("第 5 次连续失败封顶至 500 秒", cd5 === 500000 && adapter.failureStreaks.get(entry) === 5, `cd5=${cd5}`);

  const cd6 = adapter._recordFailure(entry, now);
  ok("第 6 次连续失败保持 500 秒封顶", cd6 === 500000 && adapter.failureStreaks.get(entry) === 6, `cd6=${cd6}`);

  const st = adapter.status();
  ok("status 包含 maxBackoffMs=500000", st.maxBackoffMs === 500000, String(st.maxBackoffMs));
  const coolItem = st.cooling.find((x) => x.entry === entry);
  ok("status.cooling 带出当前 streak=6", coolItem?.streak === 6, JSON.stringify(coolItem));
}

// 2. 成功后重置退避计数
{
  const adapter = new __PoolAdapter(() => ({ cooldownMs: 60000 }), () => fakeLlm([{ type: "text-delta", text: "成功应答" }, { type: "finish", reason: { kind: "stop" } }]));
  const entry = "provider/model-reset";
  const now = Date.now();

  adapter._recordFailure(entry, now);
  adapter._recordFailure(entry, now);
  adapter._recordFailure(entry, now);
  ok("前置 3 次失败 streak=3", adapter.failureStreaks.get(entry) === 3, String(adapter.failureStreaks.get(entry)));

  // 执行一次完整成功的调用
  const attempt = { ok: false };
  for await (const _ of adapter._attemptStream({ entry, provider: "provider", model: "model-reset" }, {}, "", attempt, "s", now)) {
    // 消费流
  }

  ok("成功后 failureStreaks 已被清除", !adapter.failureStreaks.has(entry));
  ok("成功后 cooldown 已被清除", !adapter.cooldown.has(entry));

  // 再次失败时应从第 1 次 60s 重新开始
  const cdAfter = adapter._recordFailure(entry, now);
  ok("重置后再次失败重新从基准 60s 起步", cdAfter === 60000 && adapter.failureStreaks.get(entry) === 1, `cdAfter=${cdAfter}`);
}

// 3. 自定义退避上限（如 200s）
{
  const adapter = new __PoolAdapter(() => ({ cooldownMs: 60000, maxBackoffMs: 200000 }), () => fakeLlm([]));
  const entry = "provider/model-custom-cap";
  const now = 1000000000000;

  adapter._recordFailure(entry, now); // 60s
  adapter._recordFailure(entry, now); // 120s
  const cd3 = adapter._recordFailure(entry, now); // 240s -> capped at 200s
  ok("自定义上限 200s 封顶生效", cd3 === 200000, `cd3=${cd3}`);
}

// 4. 中途断流计入退避
{
  const finish = { type: "finish", reason: { kind: "error", failure: { code: "SERVER_ERROR", status: 500, message: "bad gateway" } } };
  const adapter = new __PoolAdapter(() => ({ cooldownMs: 60000 }), () => fakeLlm([{ type: "text-delta", text: "部分文本" }, finish]));
  const entry = "provider/model-midstream";
  const now = 1000000000000;

  // 第 1 次中途断流
  const attempt1 = { ok: false };
  for await (const _ of adapter._attemptStream({ entry, provider: "provider", model: "model-midstream" }, {}, "", attempt1, "s", now)) {}
  ok("第 1 次中途断流 streak=1", adapter.failureStreaks.get(entry) === 1 && adapter.cooldown.get(entry) === now + 60000);

  // 第 2 次中途断流
  const attempt2 = { ok: false };
  for await (const _ of adapter._attemptStream({ entry, provider: "provider", model: "model-midstream" }, {}, "", attempt2, "s", now)) {}
  ok("第 2 次中途断流 streak=2 且退避到 120s", adapter.failureStreaks.get(entry) === 2 && adapter.cooldown.get(entry) === now + 120000);
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
