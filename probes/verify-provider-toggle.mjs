/**
 * 供应商启用 / 禁用回归（2026-10-26）。
 *
 * 需求：禁用的供应商不出现在**对话的模型选择列表**里。
 *
 * 宿主的 `llm-pi-ai` 与 `dsh-llm` 都没有"按供应商禁用"的字段（全库搜不到
 * disabledProviders / hiddenProviders / providerDisabled），所以实现只能是：
 *   禁用 = 把该供应商从 `llm-pi-ai.providers` 里摘掉，完整定义暂存到 model-pool.json，
 *          宿主随即不再为它注册 adapter → 模型选择器里自然消失；
 *   启用 = 把暂存的定义原样写回。
 *
 * 覆盖八件事：
 *   1. 禁用后配置里不再有该供应商；2. 完整定义进了暂存（深比较一致，可无损恢复）；
 *   3. 禁用的同时算出受影响的链条目；4. 写前留下 patch 备份；
 *   5. /models 立刻看不到它的模型（读的是活配置，不是磁盘文件）；
 *   6. 启用后模型原样回来；7. 没有暂存时启用要报错；8. 冲突重试 / 跨域拒绝。
 *
 * 纪律：假 settings、临时 DSH_HOME 与 profile，不打真实网络。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-toggle-"));
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

const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-toggle-profile-"));
mkdirSync(profileDir, { recursive: true });
const patchPath = join(profileDir, "cordis.patch.yml");
// 磁盘上故意保留 a，用来验证插件读的是活配置而不是这个文件
writeFileSync(
  patchPath,
  [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      a:",
    "        apiKeyEnv: A_KEY",
    "        api: openai-completions",
    "        baseURL: http://127.0.0.1:1/v1",
    "        models:",
    "          - id: a1",
    "      b:",
    "        apiKeyEnv: B_KEY",
    "        api: openai-completions",
    "        baseURL: http://127.0.0.1:1/v1",
    "        models:",
    "          - id: b1",
    "",
  ].join("\n"),
);
writeFileSync(
  join(profileDir, "model-pool.json"),
  JSON.stringify({
    activeScheme: "t",
    schemes: { t: { chain: ["a/a1", "b/b1"] } },
  }, null, 2),
);

const A_DEF = { apiKeyEnv: "A_KEY", api: "openai-completions", baseURL: "http://127.0.0.1:1/v1", models: [{ id: "a1", name: "A One", contextWindow: 8192 }] };
const B_DEF = { apiKeyEnv: "B_KEY", api: "openai-completions", baseURL: "http://127.0.0.1:1/v1", models: [{ id: "b1" }] };
const live = { providers: { a: structuredClone(A_DEF), b: structuredClone(B_DEF) } };
let revision = 1;
let conflictOnce = false;

const settings = {
  describe: () => [{ ns: "llm-pi-ai", value: structuredClone(live), revision }],
  replace: async (_ns, next) => {
    if (conflictOnce) {
      conflictOnce = false;
      throw Object.assign(new Error("conflict"), { code: "SETTINGS_CONFLICT" });
    }
    live.providers = structuredClone(next.providers);
    revision += 1;
  },
};

const routes = new Map();
const ctx = {
  get: (k) => {
    if (k === "profileContext") return { dir: profileDir, patchPath };
    if (k === "settings") return settings;
    return undefined;
  },
  inject: (names, cb) => {
    const scope = {};
    if (names.includes("settings")) scope.settings = settings;
    cb(scope);
  },
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  credentials: { resolve: async () => ({ value: "k" }) },
  webServer: { register: (def) => routes.set(def.path, def) },
  tools: { register() {} },
  on: () => () => {},
  effect: (fn) => { fn(); },
};

mod.apply(ctx);

console.log("model-pool 供应商启用/禁用");

function makeRes() {
  return { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
}
function makeReq(payload, opts = {}) {
  return {
    method: opts.method || "POST",
    headers: { "content-type": "application/json", ...(opts.origin ? { origin: opts.origin } : {}) },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload ?? {}));
    },
  };
}
const toggle = routes.get("/api/model-pool/toggle-provider");
const modelsRoute = routes.get("/api/model-pool/models");
ok("toggle-provider 路由已注册", Boolean(toggle));

if (toggle && modelsRoute) {
  // 禁用 a
  {
    const res = makeRes();
    await toggle.handler(makeReq({ provider: "a", enabled: false }), res);
    const j = JSON.parse(res.body);
    ok("禁用成功", j.ok === true && j.enabled === false, res.body.slice(0, 200));
    ok("配置里不再有该供应商", live.providers.a === undefined, JSON.stringify(Object.keys(live.providers)));
    ok("b 不受影响", Boolean(live.providers.b), JSON.stringify(Object.keys(live.providers)));
    const st = JSON.parse(readFileSync(join(profileDir, "model-pool.json"), "utf8"));
    ok("完整定义进了暂存（可无损恢复）", JSON.stringify(st.disabledProviders?.a) === JSON.stringify(A_DEF), JSON.stringify(st.disabledProviders?.a));
    ok("算出受影响的链条目", Array.isArray(j.affected) && j.affected.some((x) => x.includes("a/a1")), JSON.stringify(j.affected));
    const backups = readdirSync(profileDir).filter((f) => f.startsWith("cordis.patch.yml.bak-modelpool-"));
    ok("写前留下 patch 备份", backups.length === 1, backups.join(","));
  }

  // /models 立刻看不到 a（读活配置，磁盘文件里其实还有 a）
  {
    const res = makeRes();
    await modelsRoute.handler({ method: "GET", headers: {} }, res);
    const j = JSON.parse(res.body);
    const keys = (j.models || []).map((m) => m.key);
    ok("/models 不再包含被禁用供应商的模型", !keys.includes("a/a1"), keys.slice(0, 8).join(","));
    ok("/models 仍包含其他供应商的模型", keys.includes("b/b1"), keys.slice(0, 8).join(","));
  }

  // 冲突重试
  {
    conflictOnce = true;
    const res = makeRes();
    await toggle.handler(makeReq({ provider: "b", enabled: false }), res);
    const j = JSON.parse(res.body);
    ok("遇到 SETTINGS_CONFLICT 会重试并成功", j.ok === true && live.providers.b === undefined, res.body.slice(0, 200));
  }

  // 启用 a
  {
    const res = makeRes();
    await toggle.handler(makeReq({ provider: "a", enabled: true }), res);
    const j = JSON.parse(res.body);
    ok("启用成功", j.ok === true && j.enabled === true, res.body.slice(0, 200));
    ok("启用后定义原样回来", JSON.stringify(live.providers.a) === JSON.stringify(A_DEF), JSON.stringify(live.providers.a));
    const st = JSON.parse(readFileSync(join(profileDir, "model-pool.json"), "utf8"));
    ok("启用后暂存清空该条", !st.disabledProviders || st.disabledProviders.a === undefined, JSON.stringify(st.disabledProviders));
  }

  // 没有暂存却要启用
  {
    const res = makeRes();
    await toggle.handler(makeReq({ provider: "zzz", enabled: true }), res);
    const j = JSON.parse(res.body);
    ok("无暂存时启用给出可判读错误", j.ok === false && /暂存定义/.test(j.error || ""), res.body.slice(0, 200));
  }

  // 跨域
  {
    const res = makeRes();
    await toggle.handler(makeReq({ provider: "a", enabled: false }, { origin: "https://evil.example.com" }), res);
    ok("跨域写操作返回 403", res.statusCode === 403, String(res.statusCode));
  }
}

rmSync(profileDir, { recursive: true, force: true });
if (savedUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = savedUserProfile;
if (savedHome === undefined) delete process.env.HOME;
else process.env.HOME = savedHome;
if (savedDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = savedDshHome;
rmSync(tempHome, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
