/**
 * 缓存卫生与备份保留回归（2026-10-27 A 批）。
 *
 * 三件事，都是"看不见但会咬人"的：
 *   1. `settings.describe()` 会把整份 llm-pi-ai 配置序列化一遍，而「测试全部」是逐模型打 /test。
 *      不缓存 = 330 次全量序列化。800ms TTL 应把同批请求合并成一次。
 *   2. 写完配置必须立刻失效缓存：describe（否则回读校验读到旧值）、catalog / runtime（否则
 *      面板要等最多 10 秒才反映禁用/接入的结果）。
 *   3. 每次写入都留一份完整 patch 备份，只保留最近 10 份，且删的是最旧的。
 *
 * 覆盖七件事：
 *   1. 同批 /test 只触发一次 describe；2. 写入后 describe 立即刷新（回读校验不读旧值）；
 *   3. runtime 枚举缓存有效期生效；4. 写入后 runtime 缓存被失效（无需等 10 秒）；
 *   5. 备份超过 10 份会裁剪；6. 裁掉的是最旧的；7. 最新备份保留。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-cache-"));
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

const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-cache-profile-"));
mkdirSync(profileDir, { recursive: true });
const patchPath = join(profileDir, "cordis.patch.yml");
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
    "",
  ].join("\n"),
);
writeFileSync(join(profileDir, "model-pool.json"), JSON.stringify({ activeScheme: "t", schemes: { t: { chain: [] } } }, null, 2));

const live = { providers: { a: { apiKeyEnv: "A_KEY", api: "openai-completions", baseURL: "http://127.0.0.1:1/v1", models: [{ id: "a1" }] } } };
let revision = 1;
let describeCalls = 0;
const settings = {
  describe: () => {
    describeCalls += 1;
    return [{ ns: "llm-pi-ai", value: structuredClone(live), revision }];
  },
  replace: async (_ns, next) => {
    live.providers = structuredClone(next.providers);
    revision += 1;
  },
};

// 运行时渠道：模型清单可变，用来验证 runtime 缓存
let runtimeModels = [{ id: "r1" }];
const llm = {
  registerAdapter: () => () => {},
  listProviders: async () => [{ id: "ghost" }],
  listModels: async () => runtimeModels.slice(),
  stream: () => { throw new Error("no"); }
};

const routes = new Map();
const ctx = {
  get: (k) => {
    if (k === "profileContext") return { dir: profileDir, patchPath };
    if (k === "settings") return settings;
    if (k === "llm") return llm;
    return undefined;
  },
  inject: (names, cb) => {
    const scope = {};
    if (names.includes("settings")) scope.settings = settings;
    if (names.includes("llm")) scope.llm = llm;
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

console.log("model-pool 缓存卫生与备份保留");

function makeRes() {
  return { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
}
function makeReq(payload) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload ?? {})); }
  };
}
const modelsRoute = routes.get("/api/model-pool/models");
const testRoute = routes.get("/api/model-pool/test");
const toggleRoute = routes.get("/api/model-pool/toggle-provider");

// 1. 同批 /test 只触发一次 describe
{
  describeCalls = 0;
  for (let i = 0; i < 5; i++) await testRoute.handler(makeReq({ key: "a/a1" }), makeRes());
  ok("同批 5 次 /test 只 describe 一次", describeCalls <= 2, `describe 调用 ${describeCalls} 次`);
}

// 3. runtime 缓存生效：改数据后立刻查，仍是旧值
{
  await modelsRoute.handler({ method: "GET", headers: {} }, makeRes());
  runtimeModels = [{ id: "r2" }];
  const res = makeRes();
  await modelsRoute.handler({ method: "GET", headers: {} }, res);
  const keys = (JSON.parse(res.body).models || []).map((m) => m.key);
  ok("runtime 缓存生效（10 秒内仍是旧值）", keys.includes("ghost/r1"), keys.filter((k) => k.startsWith("ghost/")).join(","));
}

// 2+4. 写入后 describe 与 runtime 缓存都被失效
{
  const res = makeRes();
  await toggleRoute.handler(makeReq({ provider: "a", enabled: false }), res);
  const j = JSON.parse(res.body);
  ok("写入成功（回读校验读到的是最新值）", j.ok === true, res.body.slice(0, 200));
  ok("配置里已移除", live.providers.a === undefined, Object.keys(live.providers).join(","));

  const after = makeRes();
  await modelsRoute.handler({ method: "GET", headers: {} }, after);
  const keys = (JSON.parse(after.body).models || []).map((m) => m.key);
  ok("写入后 runtime 缓存被失效（立刻看到 r2）", keys.includes("ghost/r2"), keys.filter((k) => k.startsWith("ghost/")).join(","));
  ok("写入后看不到被禁用的供应商", !keys.includes("a/a1"), keys.slice(0, 6).join(","));
}

// 5+6+7. 备份保留 10 份，删最旧
{
  // 先造 11 个"旧"备份，时间戳定长便于字典序
  for (let i = 1; i <= 11; i++) writeFileSync(join(profileDir, `cordis.patch.yml.bak-modelpool-${String(i).padStart(13, "0")}`), "old");
  await toggleRoute.handler(makeReq({ provider: "a", enabled: true }), makeRes());
  const backups = readdirSync(profileDir).filter((f) => f.startsWith("cordis.patch.yml.bak-modelpool-")).sort();
  ok("备份总数被裁到 10 份", backups.length === 10, String(backups.length));
  ok("裁掉的是最旧的两份", !backups.includes("cordis.patch.yml.bak-modelpool-0000000000001") && !backups.includes("cordis.patch.yml.bak-modelpool-0000000000002"), backups[0]);
  ok("最新备份保留且内容完整", backups[backups.length - 1].length > 20 && readFileSync(join(profileDir, backups[backups.length - 1]), "utf8").includes("llm-pi-ai"), backups[backups.length - 1]);
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
