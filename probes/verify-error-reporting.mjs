/**
 * 「失败必须说得清」与「冷却可配」回归。
 *
 * 背景（2026-10-25）：运行实例的 `/api/model-pool/current` 里出现过
 *   { "entry": "qoder/DeepSeek-Flash", "ok": false, "error": null }
 * ——判了失败，却没有原因。查下来是 `_attemptStream` 的**中途断流**分支：
 * 已经有产出后再收到 error finish，旧代码直接 `yield chunk; return`，
 * 既不写 `attempt.error` 也不写冷却（本该负责这件事的 `_wrap` 从未被调用）。
 * 后果有两个：面板上看不出为什么失败；同一条渠道下一轮还会从链头再撞一次。
 *
 * 覆盖八件事：
 *   1. 中途断流：不抛（内容已经交给宿主了）、attempt.ok=false、midStream=true、
 *      error 带 code、冷却已写入、错误块原样透传。
 *   2. 无产出错误：仍然抛，文案含「无正文错误」+ code。
 *   3. reason 里什么都没有（上游直接断开）：error 不许是 null，必须有兜底文案。
 *   4. 冷却默认 60 秒；`state.cooldownMs` 可改；下限 5 秒、上限 1 小时。
 *   5. `/api/model-pool/chain` POST 能持久化 cooldownMs，GET 能读回。
 *
 * 纪律同既有探针：假 llm 不打上游、临时 DSH_HOME、js-yaml 走宿主真包。
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-err-"));
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

/** state 为 readState 的返回值：{} = 默认配置，{cooldownMs: N} = 自定冷却 */
async function run(chunks, state = {}) {
  const adapter = new __PoolAdapter(() => state, () => fakeLlm(chunks));
  const attempt = { ok: false };
  const out = [];
  let error = null;
  const now = Date.now();
  try {
    for await (const ch of adapter._attemptStream(
      { entry: "probe/m", provider: "probe", model: "m" },
      {},
      "",
      attempt,
      "scheme",
      now,
    )) {
      out.push(ch);
    }
  } catch (e) {
    error = e;
  }
  return { out, error, attempt, adapter, now };
}

console.log("model-pool 失败原因与冷却配置");

// 1. 中途断流：有产出后收到 error finish
{
  const finish = { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", status: 429, message: "slow down" } } };
  const r = await run([{ type: "text-delta", text: "部分回答" }, finish]);
  ok("中途断流不抛（内容已交给宿主）", r.error === null, r.error?.message);
  ok("错误块原样透传", r.out.length === 2 && r.out[1] === finish);
  ok("attempt 标记失败", r.attempt.ok === false);
  ok("attempt 标记 midStream", r.attempt.midStream === true);
  ok(
    "attempt.error 带 code 与状态码",
    typeof r.attempt.error === "string" && /RATE_LIMIT/.test(r.attempt.error) && /HTTP 429/.test(r.attempt.error),
    r.attempt.error,
  );
  const until = r.adapter.cooldown.get("probe/m");
  ok("中途断流也写冷却", typeof until === "number" && until > r.now, String(until));
  ok("lastUse 标注中途断流", r.adapter.lastUse?.midStreamError === r.attempt.error, JSON.stringify(r.adapter.lastUse));
}

// 2. 无产出错误：继续抛
{
  const r = await run([{ type: "finish", reason: { kind: "error", failure: { code: "QUOTA", message: "429" } } }]);
  ok(
    "无产出错误仍抛，文案含「无正文错误」+ code",
    r.error !== null && /无正文错误/.test(r.error.message) && /QUOTA/.test(r.error.message),
    r.error?.message,
  );
}

// 3. reason 全空：不许留 null
{
  const r = await run([{ type: "text-delta", text: "x" }, { type: "finish", reason: { kind: "error", failure: {} } }]);
  ok(
    "空 failure 也给兜底文案（不是 null）",
    typeof r.attempt.error === "string" && r.attempt.error.includes("未附带原因"),
    String(r.attempt.error),
  );

  const r2 = await run([{ type: "finish", reason: { kind: "error", failure: {} } }]);
  ok(
    "空 failure + 无产出：错误文案同样有兜底",
    r2.error !== null && /未附带原因/.test(r2.error.message),
    r2.error?.message,
  );
}

// 4. 冷却：默认、可配、上下限
{
  const base = await run([{ type: "finish", reason: { kind: "stop" } }]);
  ok("默认冷却 60 秒", base.adapter.status().cooldownMs === 60000, String(base.adapter.status().cooldownMs));

  const custom = await run([{ type: "finish", reason: { kind: "stop" } }], { cooldownMs: 30000 });
  ok("cooldownMs 可配（30s）", custom.adapter.status().cooldownMs === 30000, String(custom.adapter.status().cooldownMs));

  const low = await run([{ type: "finish", reason: { kind: "stop" } }], { cooldownMs: 1 });
  ok("低于 5 秒被抬到 5000ms", low.adapter.status().cooldownMs === 5000, String(low.adapter.status().cooldownMs));

  const high = await run([{ type: "finish", reason: { kind: "stop" } }], { cooldownMs: 99999999 });
  ok("超过 1 小时被压到 3600000ms", high.adapter.status().cooldownMs === 3600000, String(high.adapter.status().cooldownMs));
}

// 5. HTTP：POST 持久化 / GET 读回
{
  const routes = new Map();
  const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-profile-"));
  const ctx = {
    get: (k) => (k === "profileContext" ? { dir: profileDir, patchPath: join(profileDir, "cordis.patch.yml") } : undefined),
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    credentials: { resolve: async () => undefined },
    webServer: { register: (def) => routes.set(def.path, def) },
    tools: { register() {} },
    on: () => () => {},
    effect: (fn) => {
      fn();
    },
  };
  mod.apply(ctx);
  const chainRoute = routes.get("/api/model-pool/chain");
  ok("/api/model-pool/chain 已注册", Boolean(chainRoute));

  if (chainRoute) {
    const body = JSON.stringify({ cooldownMs: 45000 });
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    };
    const res = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
    await chainRoute.handler(req, res);
    const saved = JSON.parse(readFileSync(join(profileDir, "model-pool.json"), "utf8"));
    ok("POST 把 cooldownMs 写进 model-pool.json", saved.cooldownMs === 45000, String(saved.cooldownMs));

    const getRes = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
    await chainRoute.handler({ method: "GET", headers: {} }, getRes);
    const readBack = JSON.parse(getRes.body);
    ok("GET 读回 cooldownMs", readBack.state?.cooldownMs === 45000, JSON.stringify(readBack.state?.cooldownMs));
  }
  rmSync(profileDir, { recursive: true, force: true });
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
