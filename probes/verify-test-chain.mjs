/**
 * 「测试当前链路」回归。
 *
 * 需求（2026-10-25）：面板要能一键只测当前激活方案链上的模型，而不是整张清单。
 *
 * 为什么要单独一条路由：链路里常混着**运行时注册的渠道**（qoder / trae / workbuddy4），
 * 它们由对接插件经 `registerAdapter` 注入，没有 baseURL + apiKeyEnv 可以直连；
 * 旧的单模型 `/api/model-pool/test` 只认配置行，喂这类 key 会直接 404。
 * 所以 `/test-chain` 按渠道类型分叉：
 *   - 配置行 + openai-completions/deepseek → 直连探（能拿到真实 HTTP 状态）
 *   - 其余 → 经宿主 `llm.stream` 探（协议/端点/凭据都由适配器负责）
 *
 * 覆盖七件事：
 *   1. 路由注册；2. 只测链上条目（结果键集合 == 链）；3. 顺序保持；
 *   4. 配置渠道 channel=direct；5. 运行时渠道 channel=runtime 且成功记为 ok；
 *   6. 运行时错误块 → fail 且 error 非空；7. GET 405 / 跨域 403 / 空链不报错。
 *
 * 纪律同既有探针：不打真实上游（配置渠道指向 127.0.0.1:1，立即 ECONNREFUSED）、
 * 临时 DSH_HOME、js-yaml 走宿主真包。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-chain-"));
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

// —— 假宿主 ——
const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-chain-profile-"));
mkdirSync(profileDir, { recursive: true });

// 配置渠道：指向 127.0.0.1:1，连接立即被拒，不会碰真实网络
writeFileSync(
  join(profileDir, "cordis.patch.yml"),
  [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      cfg:",
    "        apiKeyEnv: PROBE_KEY",
    "        api: openai-completions",
    "        baseURL: http://127.0.0.1:1/v1",
    "        models:",
    "          - id: probe-model",
    "",
  ].join("\n"),
);

const chain = ["cfg/probe-model", "ghost/reg-ok", "ghost/reg-bad"];
writeFileSync(
  join(profileDir, "model-pool.json"),
  JSON.stringify({ activeScheme: "t", schemes: { t: { chain } }, cooldownMs: 60000 }, null, 2),
);

const llm = {
  registerAdapter: () => () => {},
  listProviders: async () => [{ id: "ghost" }],
  stream({ model }) {
    if (model === "reg-bad") {
      return (async function* () {
        yield { type: "finish", reason: { kind: "error", failure: { code: "QUOTA", status: 402, message: "no credit" } } };
      })();
    }
    return (async function* () {
      yield { type: "text-delta", text: "hi" };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  },
};

const routes = new Map();
const ctx = {
  get: (k) => {
    if (k === "profileContext") return { dir: profileDir, patchPath: join(profileDir, "cordis.patch.yml") };
    if (k === "llm") return llm;
    return undefined;
  },
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  credentials: { resolve: async () => ({ value: "probe-key" }) },
  webServer: { register: (def) => routes.set(def.path, def) },
  tools: { register() {} },
  on: () => () => {},
  effect: (fn) => {
    fn();
  },
};

mod.apply(ctx);

console.log("model-pool 链路自检");

const route = routes.get("/api/model-pool/test-chain");
ok("/api/model-pool/test-chain 已注册", Boolean(route));

function makeRes() {
  return {
    statusCode: 0,
    body: "",
    setHeader() {},
    end(b) {
      this.body = b;
    },
  };
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

if (route) {
  const res = makeRes();
  await route.handler(makeReq({}), res);
  const j = JSON.parse(res.body);

  ok("POST 返回 ok", j.ok === true, res.body.slice(0, 200));
  ok("用的是当前激活方案", j.scheme === "t", String(j.scheme));
  ok("链顺序原样返回", JSON.stringify(j.chain) === JSON.stringify(chain), JSON.stringify(j.chain));
  ok(
    "只测链上条目，不多测",
    JSON.stringify(Object.keys(j.results).sort()) === JSON.stringify([...chain].sort()),
    JSON.stringify(Object.keys(j.results)),
  );

  const direct = j.results["cfg/probe-model"];
  ok("配置渠道走直连（channel=direct）", direct?.channel === "direct", JSON.stringify(direct));
  ok("连不上时判 fail", direct?.status === "fail", JSON.stringify(direct));

  const runtimeOk = j.results["ghost/reg-ok"];
  ok("运行时渠道走宿主（channel=runtime）", runtimeOk?.channel === "runtime", JSON.stringify(runtimeOk));
  ok("运行时渠道成功判 ok 且有延迟", runtimeOk?.status === "ok" && typeof runtimeOk.latency === "number", JSON.stringify(runtimeOk));

  const runtimeBad = j.results["ghost/reg-bad"];
  ok("运行时错误块判 fail", runtimeBad?.status === "fail", JSON.stringify(runtimeBad));
  ok(
    "失败原因不为空且带 code",
    typeof runtimeBad?.error === "string" && /QUOTA/.test(runtimeBad.error),
    String(runtimeBad?.error),
  );

  // GET 必须拒绝
  const getRes = makeRes();
  await route.handler({ method: "GET", headers: {} }, getRes);
  ok("GET 返回 405", getRes.statusCode === 405, String(getRes.statusCode));

  // 跨域必须拒绝
  const evilRes = makeRes();
  await route.handler(makeReq({}, { origin: "https://evil.example.com" }), evilRes);
  ok("跨域写操作返回 403", evilRes.statusCode === 403, String(evilRes.statusCode));

  // 空链路：不报错，返回空结果
  writeFileSync(
    join(profileDir, "model-pool.json"),
    JSON.stringify({ activeScheme: "empty", schemes: { empty: { chain: [] } } }, null, 2),
  );
  const emptyRes = makeRes();
  await route.handler(makeReq({}), emptyRes);
  const ej = JSON.parse(emptyRes.body);
  ok("空链路返回空结果且不报错", ej.ok === true && (ej.chain || []).length === 0, emptyRes.body.slice(0, 160));
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
