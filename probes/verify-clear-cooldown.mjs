/**
 * 一键清空冷却与重置退避（Clear Cooldown & Reset Backoff）探针校验。
 *
 * 验证：
 *   1. 单条清理：adapter.clearCooldown(entry) 仅清理指定渠道的 cooldown 与 failureStreaks，保留其他渠道。
 *   2. 全量清理：adapter.clearCooldown() 清空全部渠道的冷却倒计时与退避阶梯计数。
 *   3. lastUse 隔离性：清理冷却时绝对不修改或污染 lastUse（历史命中模型）。
 *   4. HTTP 路由安全性：POST /api/model-pool/clear-cooldown 校验本地来源、405 拦截非 POST、返回最新 status。
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-clear-cd-"));
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

console.log("model-pool 一键清空冷却与重置退避校验");

// 1. 单条清理与全量清理
{
  const adapter = new __PoolAdapter(() => ({ cooldownMs: 60000 }), () => ({ stream() {} }));
  const now = Date.now();
  adapter._recordFailure("p1/m1", now);
  adapter._recordFailure("p1/m1", now); // streak = 2
  adapter._recordFailure("p2/m2", now); // streak = 1

  ok("初始 p1/m1 冷却中且 streak=2", adapter.cooldown.has("p1/m1") && adapter.failureStreaks.get("p1/m1") === 2);
  ok("初始 p2/m2 冷却中且 streak=1", adapter.cooldown.has("p2/m2") && adapter.failureStreaks.get("p2/m2") === 1);

  // 单条清理 p1/m1
  adapter.clearCooldown("p1/m1");
  ok("单条清理后 p1/m1 冷却被移除", !adapter.cooldown.has("p1/m1"));
  ok("单条清理后 p1/m1 退避计数被清空", !adapter.failureStreaks.has("p1/m1"));
  ok("单条清理不影响未指定的 p2/m2 冷却", adapter.cooldown.has("p2/m2"));
  ok("单条清理不影响未指定的 p2/m2 退避计数", adapter.failureStreaks.get("p2/m2") === 1);

  // 再给 p1/m1 加故障后全量清理
  adapter._recordFailure("p1/m1", now);
  adapter.clearCooldown();
  ok("全量清理后 cooldown map 为空", adapter.cooldown.size === 0);
  ok("全量清理后 failureStreaks 为空", adapter.failureStreaks.size === 0);
  ok("全量清理后 status().cooling 为空数组", adapter.status().cooling.length === 0);
}

// 2. 验证与 lastUse 的隔离性（绝不篡改历史命中与思考档位上下文）
{
  const adapter = new __PoolAdapter(() => ({ cooldownMs: 60000 }), () => ({ stream() {} }));
  const mockLastUse = {
    scheme: "纯deepseek",
    provider: "workbuddy",
    model: "deepseek-v4.1-flash",
    entry: "workbuddy/deepseek-v4.1-flash",
    at: Date.now(),
    attempts: 1,
  };
  adapter.lastUse = mockLastUse;
  adapter._recordFailure("trae/DeepSeek-V4-Flash", Date.now());

  adapter.clearCooldown();
  ok("清空冷却后 lastUse 保持原样不被修改", adapter.lastUse === mockLastUse && adapter.lastUse.provider === "workbuddy");
}

// 3. HTTP 路由测试
{
  const routes = new Map();
  const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-clear-route-"));
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
  const route = routes.get("/api/model-pool/clear-cooldown");
  ok("路由 /api/model-pool/clear-cooldown 已注册", Boolean(route));

  if (route) {
    // 405 测试
    const resGet = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
    await route.handler({ method: "GET", headers: {} }, resGet);
    ok("非 POST 请求返回 405", resGet.statusCode === 405);

    // 403 跨域来源测试
    const resForbidden = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
    await route.handler({ method: "POST", headers: { origin: "https://attacker.com" } }, resForbidden);
    ok("非本地来源返回 403", resForbidden.statusCode === 403);

    // 全量清理 POST
    const resPost = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
    const reqPost = {
      method: "POST",
      headers: { host: "127.0.0.1:4983" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({}));
      },
    };
    await route.handler(reqPost, resPost);
    ok("POST 全量清理返回 200", resPost.statusCode === 200);
    const parsed = JSON.parse(resPost.body);
    ok("返回结构 cleared='all'", parsed.ok === true && parsed.cleared === "all");
    ok("返回结构包含实时 status", Array.isArray(parsed.status?.cooling));
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
