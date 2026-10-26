/**
 * 单模型测试 `/api/model-pool/test` 的渠道分叉（2026-10-26 P1）。
 *
 * 旧实现只查 `llm-pi-ai.providers`，对运行时由对接插件 `registerAdapter` 注册的渠道
 * （qoder / qoder-cn / trae / workbuddy*）直接回 404「未找到该模型」——面板上这些行
 * 明明有「测」按钮，点了却报错，和链路自检的结果自相矛盾。
 *
 * 现在与 `/test-chain` 共用 `probeEntry()`：配置渠道直连、其余走宿主 `llm.stream`。
 * 顺带覆盖状态文件缓存的失效（改文件后必须读到新内容，不能被 mtime 缓存挡住）。
 *
 * 纪律：不打真实上游（配置渠道指向 127.0.0.1:1）、临时 DSH_HOME、js-yaml 走宿主真包。
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-single-"));
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

const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-single-profile-"));
mkdirSync(profileDir, { recursive: true });
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
writeFileSync(
  join(profileDir, "model-pool.json"),
  JSON.stringify({ activeScheme: "t", schemes: { t: { chain: ["ghost/reg-ok"] } } }, null, 2),
);

const llm = {
  registerAdapter: () => () => {},
  listProviders: async () => [{ id: "ghost" }],
  listModels: async () => [{ id: "reg-ok" }, { id: "reg-bad" }],
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
  effect: (fn) => { fn(); },
};

mod.apply(ctx);

console.log("model-pool 单模型测试分叉");

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

const route = routes.get("/api/model-pool/test");
ok("/api/model-pool/test 已注册", Boolean(route));

if (route) {
  // 1. 运行时渠道：本次修复的重点，旧版这里回 404
  {
    const res = makeRes();
    await route.handler(makeReq({ key: "ghost/reg-ok" }), res);
    const j = JSON.parse(res.body);
    ok("运行时渠道不再 404", res.statusCode === 200 && j.ok === true, `${res.statusCode} ${res.body.slice(0, 160)}`);
    ok("运行时渠道走宿主探测（channel=runtime）", j.channel === "runtime", String(j.channel));
    ok("运行时渠道成功判 ok", j.status === "ok" && typeof j.latency === "number", JSON.stringify(j));
  }

  // 2. 配置渠道：仍走直连
  {
    const res = makeRes();
    await route.handler(makeReq({ key: "cfg/probe-model" }), res);
    const j = JSON.parse(res.body);
    ok("配置渠道走直连（channel=direct）", j.channel === "direct", JSON.stringify(j));
    ok("连不上时判 fail", j.status === "fail", JSON.stringify(j));
  }

  // 3. 运行时错误块：原因不为空
  {
    const res = makeRes();
    await route.handler(makeReq({ key: "ghost/reg-bad" }), res);
    const j = JSON.parse(res.body);
    ok("运行时错误块判 fail", j.status === "fail", JSON.stringify(j));
    ok("失败原因带 code", typeof j.error === "string" && /QUOTA/.test(j.error), String(j.error));
  }

  // 4. 非法键：不 404，给可判读原因
  {
    const res = makeRes();
    await route.handler(makeReq({ key: "no-slash-key" }), res);
    const j = JSON.parse(res.body);
    ok("缺 provider/model 结构时判 skip 且有原因", j.status === "skip" && /provider\/model/.test(j.error || ""), JSON.stringify(j));
  }

  // 5. 缺 key：400
  {
    const res = makeRes();
    await route.handler(makeReq({}), res);
    ok("缺 key 返回 400", res.statusCode === 400, String(res.statusCode));
  }

  // 6. 状态文件缓存必须按 mtime 失效：外部改写后立刻能读到新链
  {
    const chainRoute = routes.get("/api/model-pool/chain");
    const before = makeRes();
    await chainRoute.handler({ method: "GET", headers: {} }, before);
    const b = JSON.parse(before.body);
    ok("初始读到 1 条链", b.state?.schemes?.t?.chain?.length === 1, JSON.stringify(b.state?.schemes?.t?.chain));

    writeFileSync(
      join(profileDir, "model-pool.json"),
      JSON.stringify({ activeScheme: "t", schemes: { t: { chain: ["ghost/reg-ok", "ghost/reg-bad"] } } }, null, 2),
    );
    const after = makeRes();
    await chainRoute.handler({ method: "GET", headers: {} }, after);
    const a = JSON.parse(after.body);
    ok("外部改写后缓存失效，读到 2 条链", a.state?.schemes?.t?.chain?.length === 2, JSON.stringify(a.state?.schemes?.t?.chain));
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
