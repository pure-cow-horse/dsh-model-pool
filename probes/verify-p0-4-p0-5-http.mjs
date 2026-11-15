/**
 * P0-4 / P0-5 / P2 HTTP 回归探针。
 *
 * P0-4：entry 级档位记忆优先级、旧 provider 记忆兼容边界、写入合法性校验。
 * P0-5：非池 PoolLabel 不启动 current/chain/models/efforts 轮询。
 * P2 HTTP：/models ETag/gzip、/chain 与 /current compact。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { register } from "node:module";
import { gunzipSync } from "node:zlib";

const realHome = homedir();
const jsYamlEntry = join(realHome, ".dsh", "profiles", "desktop", "node_modules", "js-yaml", "dist", "js-yaml.mjs");
try {
  await import(pathToFileURL(jsYamlEntry).href);
} catch {
  console.error(`找不到宿主真包 js-yaml（${jsYamlEntry}）`);
  process.exit(2);
}

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-p04-"));
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
const { __PoolAdapter, apply, __sendJsonCached, __compactChainState, __compactCurrentStatus } = mod;

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

function capturingLlm() {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push({ ...options });
      return (async function* () {
        yield { type: "text-delta", text: "成功" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
  };
}

async function consume(adapter) {
  for await (const _ of adapter.stream({ model: "s" })) {
    // 消费
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key] = value; },
    end(body) { this.body = body ?? ""; }
  };
}

async function callRoute(route, req) {
  const res = fakeRes();
  await route.handler(req, res);
  return { res, json: typeof res.body === "string" && res.body ? JSON.parse(res.body) : null };
}

function reqWithBody(body) {
  return {
    method: "POST",
    url: "/api/model-pool/chain",
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); }
  };
}

console.log("model-pool P0-4 / P0-5 / P2 HTTP");

// 1. entry 级记忆优先于 provider 级记忆
{
  const llm = capturingLlm();
  const state = {
    activeScheme: "s",
    schemes: { s: { chain: ["p/m1"], effort: "medium" } },
    entryEfforts: { "p/m1": "low" },
    providerEfforts: { p: "high" }
  };
  const adapter = new __PoolAdapter(() => state, () => llm);
  await consume(adapter);
  ok("entryEfforts 优先于 providerEfforts", llm.calls[0]?.reasoningEffort === "low", JSON.stringify(llm.calls[0]));
}

// 2. 没有 entry 记忆时，旧 provider 记忆仍兼容
{
  const llm = capturingLlm();
  const state = {
    activeScheme: "s",
    schemes: { s: { chain: ["p/m1"], effort: "medium" } },
    entryEfforts: {},
    providerEfforts: { p: "high" }
  };
  const adapter = new __PoolAdapter(() => state, () => llm);
  await consume(adapter);
  ok("entry 记忆为空时兼容 provider 记忆", llm.calls[0]?.reasoningEffort === "high", JSON.stringify(llm.calls[0]));
}

// 3. 一旦有 entry 记忆，不会被同供应商另一个模型的旧记忆污染
{
  const llm = capturingLlm();
  const state = {
    activeScheme: "s",
    schemes: { s: { chain: ["p/m1"], effort: "medium" } },
    entryEfforts: { "p/m2": "low" },
    providerEfforts: { p: "high" }
  };
  const adapter = new __PoolAdapter(() => state, () => llm);
  await consume(adapter);
  ok("entry 记忆存在时，未记忆条目回落到方案默认值", llm.calls[0]?.reasoningEffort === "medium", JSON.stringify(llm.calls[0]));
}

// 4. 同 provider 不同模型可以各记各的
{
  const llm = capturingLlm();
  const state = {
    activeScheme: "s",
    schemes: { s: { chain: ["p/m2"], effort: "medium" } },
    entryEfforts: { "p/m1": "low", "p/m2": "max" },
    providerEfforts: { p: "high" }
  };
  const adapter = new __PoolAdapter(() => state, () => llm);
  await consume(adapter);
  ok("同供应商不同模型读取各自 entry 档位", llm.calls[0]?.reasoningEffort === "max", JSON.stringify(llm.calls[0]));
}

// 5. 条目显式选「自动」（空字符串）时，不能被旧 provider 记忆复活
{
  const llm = capturingLlm();
  const state = {
    activeScheme: "s",
    schemes: { s: { chain: ["p/m1"], effort: "medium" } },
    entryEfforts: { "p/m1": "" },
    providerEfforts: { p: "high" }
  };
  const adapter = new __PoolAdapter(() => state, () => llm);
  await consume(adapter);
  ok("条目选自动时不注入旧 provider 档位", llm.calls[0]?.reasoningEffort === undefined || llm.calls[0]?.reasoningEffort === "自动", JSON.stringify(llm.calls[0]));
}

// 6. /efforts 暴露 entryEfforts；/chain 写入做合法性与能力校验
{
  const profileDir = mkdtempSync(join(tmpdir(), "pool-probe-p04-profile-"));
  const state = {
    activeScheme: "s",
    schemes: { s: { chain: ["p/m1", "p/m2"] } },
    providerEfforts: { p: "high" },
    entryEfforts: { "p/m1": "low" }
  };
  writeFileSync(join(profileDir, "model-pool.json"), JSON.stringify(state, null, 2), "utf8");
  const routes = new Map();
  const llm = {
    resolveModelInfo: async (_provider, model) => ({
      reasoning: model === "m1"
        ? { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "low" }
        : { efforts: [{ id: "high", name: "High" }, { id: "max", name: "Max" }], defaultEffort: "high" }
    })
  };
  const ctx = {
    get: (key) => key === "profileContext"
      ? { dir: profileDir, patchPath: join(profileDir, "cordis.patch.yml") }
      : key === "llm" ? llm : undefined,
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    credentials: { resolve: async () => undefined },
    webServer: { register: (def) => { routes.set(def.path, def); return () => {}; } },
    tools: { register() {} },
    on: () => () => {},
    effect: (fn) => { fn(); }
  };
  apply(ctx);

  const effortsRoute = routes.get("/api/model-pool/efforts");
  const chainRoute = routes.get("/api/model-pool/chain");
  const currentRoute = routes.get("/api/model-pool/current");
  ok("/efforts 路由已注册", Boolean(effortsRoute));
  ok("/chain 路由已注册", Boolean(chainRoute));
  ok("/current 路由已注册", Boolean(currentRoute));

  const efforts = await callRoute(effortsRoute, { method: "GET", url: "/api/model-pool/efforts", headers: {} });
  ok("/efforts 返回 entryEfforts", efforts.json?.entryEfforts?.["p/m1"] === "low", JSON.stringify(efforts.json?.entryEfforts));
  ok("/efforts 回报 m1 支持的档位", efforts.json?.entries?.["p/m1"]?.supported?.includes("low"), JSON.stringify(efforts.json?.entries?.["p/m1"]));

  const post = await callRoute(chainRoute, reqWithBody({
    entryEfforts: { "p/m1": "max", "p/m2": "high", "bad": "low", "p/m9": "ultra" }
  }));
  ok("/chain 接受合法 entry 键值", post.json?.ok === true, JSON.stringify(post.json));
  const saved = JSON.parse(readFileSync(join(profileDir, "model-pool.json"), "utf8"));
  ok("能力不支持的 m1=max 被拒绝", saved.entryEfforts?.["p/m1"] === undefined, JSON.stringify(saved.entryEfforts));
  ok("合法的 m2=high 被保存", saved.entryEfforts?.["p/m2"] === "high", JSON.stringify(saved.entryEfforts));
  ok("非法 key 被拒绝", saved.entryEfforts?.bad === undefined, JSON.stringify(saved.entryEfforts));
  ok("非法档位被拒绝", saved.entryEfforts?.["p/m9"] === undefined, JSON.stringify(saved.entryEfforts));

  const postAuto = await callRoute(chainRoute, reqWithBody({ entryEfforts: { "p/m2": "" } }));
  ok("/chain 接受条目级自动值", postAuto.json?.ok === true, JSON.stringify(postAuto.json));
  const savedAuto = JSON.parse(readFileSync(join(profileDir, "model-pool.json"), "utf8"));
  ok("条目级自动值被保留", savedAuto.entryEfforts?.["p/m2"] === "", JSON.stringify(savedAuto.entryEfforts));

  const compactChain = await callRoute(chainRoute, { method: "GET", url: "/api/model-pool/chain?compact=1", headers: {} });
  ok("/chain compact 标记为 compact", compactChain.json?.compact === true, JSON.stringify(compactChain.json));
  ok("/chain compact 保留方案链", compactChain.json?.state?.schemes?.s?.chain?.length === 2, JSON.stringify(compactChain.json?.state));
  ok("/chain compact 不返回 disabledProviders", compactChain.json?.state?.disabledProviders === undefined, JSON.stringify(compactChain.json?.state));
  const fullChain = await callRoute(chainRoute, { method: "GET", url: "/api/model-pool/chain", headers: {} });
  ok("/chain compact 比完整响应小", JSON.stringify(compactChain.json).length < JSON.stringify(fullChain.json).length, `${JSON.stringify(compactChain.json).length}/${JSON.stringify(fullChain.json).length}`);

  const compactCurrent = await callRoute(currentRoute, { method: "GET", url: "/api/model-pool/current?compact=1", headers: {} });
  ok("/current compact 标记为 compact", compactCurrent.json?.compact === true);
  ok("/current compact 保留 lastUse 字段", compactCurrent.json?.status?.lastUse === null || typeof compactCurrent.json?.status?.lastUse === "object", JSON.stringify(compactCurrent.json?.status));
  ok("/current compact 不返回完整 attempts 数组", compactCurrent.json?.status?.attempts === undefined, JSON.stringify(compactCurrent.json?.status));

  rmSync(profileDir, { recursive: true, force: true });
}

// 6. ETag / gzip 服务端缓存辅助
{
  const obj = { ok: true, count: 2, models: [{ key: "a/b" }, { key: "a/c" }] };
  const first = fakeRes();
  __sendJsonCached({ headers: {} }, first, obj);
  ok("首次响应设置 ETag", typeof first.headers.ETag === "string" && first.headers.ETag.startsWith('"'), String(first.headers.ETag));
  ok("首次响应设置 Vary", first.headers.Vary === "Accept-Encoding", String(first.headers.Vary));
  const etag = first.headers.ETag;
  const second = fakeRes();
  __sendJsonCached({ headers: { "if-none-match": etag } }, second, obj);
  ok("If-None-Match 命中返回 304", second.statusCode === 304, String(second.statusCode));
  ok("304 不返回 body", second.body === "", String(second.body));
  const gz = fakeRes();
  __sendJsonCached({ headers: { "accept-encoding": "gzip, deflate" } }, gz, obj);
  ok("Accept-Encoding: gzip 返回压缩体", gz.headers["Content-Encoding"] === "gzip", String(gz.headers["Content-Encoding"]));
  const decoded = JSON.parse(gunzipSync(Buffer.from(gz.body)).toString("utf8"));
  ok("gzip 内容与原始 JSON 一致", decoded.count === 2 && decoded.models.length === 2, JSON.stringify(decoded));
}

// 7. compact 辅助与客户端静态约束
{
  const big = {
    activeScheme: "s",
    schemes: { s: { chain: ["a/b"], effort: "low", noise: "x".repeat(500) } },
    disabledProviders: { big: "x".repeat(1000) },
    probeCache: { big: "x".repeat(1000) }
  };
  const compact = __compactChainState(big);
  ok("compactChainState 去掉 disabledProviders", compact.disabledProviders === undefined);
  ok("compactChainState 保留 chain/effort", compact.schemes.s.chain[0] === "a/b" && compact.schemes.s.effort === "low");
  ok("compactChainState 明显更小", JSON.stringify(compact).length < JSON.stringify(big).length, `${JSON.stringify(compact).length}/${JSON.stringify(big).length}`);

  const status = { lastUse: { entry: "a/b" }, attempts: [{ entry: "a/b", rawError: "x".repeat(500) }], attemptsAt: 123, cooling: [{ entry: "a/b", remainingMs: 1000, code: "RATE_LIMIT", source: "upstream", message: "x".repeat(500) }] };
  const compactStatus = __compactCurrentStatus(status);
  ok("compactCurrentStatus 保留 lastUse", compactStatus.lastUse.entry === "a/b");
  ok("compactCurrentStatus 去掉完整 attempts", compactStatus.attempts === undefined);
  ok("compactCurrentStatus 保留冷却摘要", compactStatus.cooling[0].code === "RATE_LIMIT" && compactStatus.cooling[0].source === "upstream");
}

{
  const clientSrc = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "client.js"), "utf8");
  const guardCount = (clientSrc.match(/if \(!isPool\) return/g) || []).length;
  ok("非池标签有两个轮询 effect 的提前返回", guardCount >= 2, String(guardCount));
  ok("两个轮询 effect 依赖 isPool", (clientSrc.match(/\}, \[isPool\]\);|\[isPool\]\);?\s*\n/g) || []).length >= 2);
  ok("PoolLabel 拉 current 时使用 compact", clientSrc.includes("/api/model-pool/current?compact=1"));
  ok("PoolLabel 拉 chain 时使用 compact", clientSrc.includes("/api/model-pool/chain?compact=1"));
  ok("PoolLabel 拉 models 时允许浏览器缓存", clientSrc.includes('fetch("/api/model-pool/models", { cache: "default" })'));
  ok("保存档位写 entryEfforts", clientSrc.includes("entryEfforts: nextEntryEfforts") && clientSrc.includes("nextEntryEfforts[anchorEntry] = v"));
  ok("保存前校验 supported", clientSrc.includes("!(supported || []).includes(v)"));
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
