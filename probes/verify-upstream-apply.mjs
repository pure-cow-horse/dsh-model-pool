/**
 * 「拉上游目录 → 勾选 → 接入 DSH」闭环回归（2026-10-26）。
 *
 * 为什么要有这条：插件此前只读配置，`fetchUpstreamModels()` 写好了却没有任何调用，
 * 面板上既没有"拉上游"入口，也没有把模型写回 `llm-pi-ai` 的能力——用户只能从
 * **已经配置过**的模型里挑，上游多出来的模型在 DSH 里根本不存在。
 *
 * 本次新增两条路由：
 *   POST /api/model-pool/upstream     {provider}         → 拉 /v1/models 全目录 + 已接入清单
 *   POST /api/model-pool/apply-models {provider, models} → 整体替换该供应商的 models
 *
 * 覆盖九件事：
 *   1. 上游目录拉取成功、已接入清单正确；2. 未知/运行时渠道给出可判读拒绝；
 *   3. 写入后 models 顺序与内容即勾选结果；4. 原有模型保留完整字段（contextWindow 不被抹掉）；
 *   5. 新增模型补最小对象 {id,name}；6. 写前留下 patch 备份；
 *   7. 回读不一致要报错（不是静默成功）；8. 空选择拒绝；9. GET 405 / 跨域 403。
 *
 * 纪律：本地起一个假上游 HTTP 服务，不打真实网络；临时 DSH_HOME 与 profile。
 */

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

// 假上游：/v1/models 返回三个模型
const upstream = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-up-"));
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

const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-up-profile-"));
mkdirSync(profileDir, { recursive: true });
const patchPath = join(profileDir, "cordis.patch.yml");
writeFileSync(
  patchPath,
  [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      ups:",
    "        apiKeyEnv: PROBE_KEY",
    "        api: openai-completions",
    `        baseURL: http://127.0.0.1:${upstreamPort}/v1`,
    "        models:",
    "          - id: m1",
    "            name: M One",
    "            contextWindow: 32000",
    "",
  ].join("\n"),
);

// 假设置服务：读改写 llm-pi-ai，按 revision 检测冲突
const settingsValue = {
  providers: {
    ups: {
      apiKeyEnv: "PROBE_KEY",
      api: "openai-completions",
      baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
      models: [{ id: "m1", name: "M One", contextWindow: 32000 }],
    },
  },
};
let revision = 1;
let dropOnWrite = false;
const settings = {
  describe: () => [{ ns: "llm-pi-ai", value: structuredClone(settingsValue), revision }],
  replace: async (_ns, next) => {
    const clone = structuredClone(next);
    if (dropOnWrite) {
      // 模拟宿主/竞态把某个模型吃掉，用于验证回读校验
      clone.providers.ups.models = clone.providers.ups.models.slice(0, 1);
      dropOnWrite = false;
    }
    settingsValue.providers = clone.providers;
    revision += 1;
  },
};

const routes = new Map();
const ctx = {
  get: (k) => {
    if (k === "profileContext") return { dir: profileDir, patchPath };
    if (k === "settings") return settings;
    if (k === "llm") return undefined;
    return undefined;
  },
  inject: (names, cb) => {
    const scope = {};
    if (names.includes("settings")) scope.settings = settings;
    cb(scope);
  },
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  credentials: { resolve: async () => ({ value: "probe-key" }) },
  webServer: { register: (def) => routes.set(def.path, def) },
  tools: { register() {} },
  on: () => () => {},
  effect: (fn) => { fn(); },
};

mod.apply(ctx);

console.log("model-pool 上游目录与接入 DSH");

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

const upRoute = routes.get("/api/model-pool/upstream");
const applyRoute = routes.get("/api/model-pool/apply-models");
ok("两条新路由都已注册", Boolean(upRoute) && Boolean(applyRoute), `${!!upRoute} ${!!applyRoute}`);

if (upRoute && applyRoute) {
  // 1. 拉上游
  {
    const res = makeRes();
    await upRoute.handler(makeReq({ provider: "ups" }), res);
    const j = JSON.parse(res.body);
    ok("拉上游目录成功", j.ok === true && j.models.length === 3, res.body.slice(0, 200));
    ok("已接入清单正确", JSON.stringify(j.existing) === JSON.stringify(["m1"]), JSON.stringify(j.existing));
  }

  // 2. 未知渠道
  {
    const res = makeRes();
    await upRoute.handler(makeReq({ provider: "qoder" }), res);
    ok("非配置型渠道给出可判读拒绝", res.statusCode === 404 && /上游目录/.test(JSON.parse(res.body).error || ""), res.body.slice(0, 160));
  }

  // 8. 空选择
  {
    const res = makeRes();
    await applyRoute.handler(makeReq({ provider: "ups", models: [] }), res);
    ok("空选择被拒绝", res.statusCode === 400, res.body.slice(0, 160));
  }

  // 3+4+5+6. 正常写入：勾 m1 + m3（m2 不勾 → 未配置过所以无影响）
  {
    const res = makeRes();
    await applyRoute.handler(makeReq({ provider: "ups", models: ["m1", "m3"] }), res);
    const j = JSON.parse(res.body);
    ok("写入成功", j.ok === true, res.body.slice(0, 200));
    const models = settingsValue.providers.ups.models;
    ok("写入后清单即勾选结果（顺序保持）", JSON.stringify(models.map((m) => m.id)) === JSON.stringify(["m1", "m3"]), JSON.stringify(models.map((m) => m.id)));
    ok("原有模型保留完整字段", models[0].contextWindow === 32000 && models[0].name === "M One", JSON.stringify(models[0]));
    ok("新模型补最小对象", models[1].id === "m3" && models[1].name === "m3", JSON.stringify(models[1]));
    const backups = readdirSync(profileDir).filter((f) => f.startsWith("cordis.patch.yml.bak-modelpool-"));
    ok("写前留下配置备份", backups.length === 1, backups.join(","));
  }

  // 7. 回读不一致必须报错
  {
    dropOnWrite = true;
    const res = makeRes();
    await applyRoute.handler(makeReq({ provider: "ups", models: ["m1", "m2", "m3"] }), res);
    const j = JSON.parse(res.body);
    ok("回读不一致时报错而不是静默成功", j.ok === false && /回读不一致/.test(j.error || ""), res.body.slice(0, 200));
  }

  // 9. 方法/来源校验
  {
    const g = makeRes();
    await upRoute.handler({ method: "GET", headers: {} }, g);
    ok("GET 返回 405", g.statusCode === 405, String(g.statusCode));
    const e = makeRes();
    await applyRoute.handler(makeReq({ provider: "ups", models: ["m1"] }, { origin: "https://evil.example.com" }), e);
    ok("跨域写操作返回 403", e.statusCode === 403, String(e.statusCode));
  }
}

upstream.close();
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
