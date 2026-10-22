// dsh-model-pool host 侧（ESM，手写免构建）
// 功能1：读 llm-pi-ai providers → 拉上游 /v1/models 全目录 → 最小请求测可用性/延迟。
// 功能2：多方案（内置3 + 自定义命名链），虚拟 provider ModelPool/Auto 自带顺延引擎接管。
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { load as loadYAML, DEFAULT_SCHEMA, Schema as YamlSchema, Type as YamlType } from "js-yaml";

// 顶层加载诊断（区分导入失败 / apply 抛错）
try {
  writeFileSync(join(homedir(), ".dsh", "model-pool-diag.log"),
    `[${new Date().toISOString()}] module loaded (top-level)\n`, { flag: "a" });
} catch { /* 忽略 */ }

//#region 配置读取（profile patch 序列）
const MODEL_SECTIONS = new Set(["llm-pi-ai", "llm-deepseek"]);
const LooseSchema = new YamlSchema({
  implicit: DEFAULT_SCHEMA.implicit,
  explicit: [...DEFAULT_SCHEMA.explicit, new YamlType("tag:yaml.org,2002:js", { kind: "scalar", resolve: () => true, construct: (v) => v })]
});

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function parseSettingsContent(raw) {
  const doc = loadYAML(raw, { schema: LooseSchema });
  const cfg = {};
  if (Array.isArray(doc)) {
    for (const entry of doc) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (typeof entry.id !== "string" || !MODEL_SECTIONS.has(entry.id)) continue;
      if (entry.config == null) continue;
      cfg[entry.id] = entry.config;
    }
    return cfg;
  }
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    for (const key of MODEL_SECTIONS) if (Object.hasOwn(doc, key)) cfg[key] = doc[key];
  }
  return cfg;
}

function settingsPaths(profile) {
  if (profile) {
    const dir = profile.dir;
    return [
      profile.patchPath,
      dir && join(dir, "cordis.patch.yml"),
      dir && join(dir, "cordis.yml")
    ].filter((p) => p && existsSync(p));
  }
  const home = dshHome();
  return ["settings.yaml", "settings.yaml.imported"].map((n) => join(home, n)).filter(existsSync);
}

const fileCache = new Map();
function readSettingsCached(profile) {
  const paths = settingsPaths(profile);
  if (profile && paths.length === 0) return {};
  const merged = {};
  for (const path of paths) {
    let mtimeMs;
    try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
    let cached = fileCache.get(path);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, cfg: parseSettingsContent(readFileSync(path, "utf8")) };
      fileCache.set(path, cached);
    }
    for (const [k, v] of Object.entries(cached.cfg)) merged[k] = v;
  }
  return merged;
}
//#endregion

//#region 错误分类（触发码）
const TRIGGER_CODES = ["AUTH", "QUOTA", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"];

function classifyFailure(status, error, bodyText) {
  if (error?.name === "AbortError") return "TIMEOUT";
  if (error && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ENETUNREACH", "fetch failed"].includes(error.code || error.type)) return "TRANSPORT";
  if (error) return "TRANSPORT";
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402 || /quota|insufficient|balance|额度|余额/i.test(bodyText || "")) return "QUOTA";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SERVER";
  if (bodyText && !/choices/i.test(bodyText)) return "EMPTY_RESPONSE";
  return "SERVER";
}
//#endregion

//#region 上游目录拉取 + 模型行
function providerRows(cfg) {
  const out = [];
  const piAi = cfg["llm-pi-ai"];
  if (piAi && typeof piAi === "object" && piAi.providers) {
    for (const [route, p] of Object.entries(piAi.providers)) {
      if (!p || typeof p !== "object") continue;
      out.push({
        kind: "pi-ai",
        provider: route,
        displayName: p.displayName || route,
        api: p.api || "openai-completions",
        baseURL: (p.baseURL || "").replace(/\/$/, ""),
        apiKeyEnv: p.apiKeyEnv || "",
        configuredModels: Array.isArray(p.models) ? p.models : []
      });
    }
  }
  return out;
}

// 本地 catalog 缓存扫描：WorkBuddy（国内/国际/多账号）与 Qoder（国内/国际），均为无 key 直连桌面通道
function localCatalogRows() {
  const home = dshHome();
  const out = [];
  let files = [];
  try { files = readdirSync(home); } catch { return out; }

  // [正则, provider(字符串或函数), label(字符串或函数), kind]
  const rules = [
    { re: /^\.workbuddy-catalog\.json$/, provider: "workbuddy", label: "WorkBuddy（国内）", kind: "workbuddy" },
    { re: /^\.workbuddy-ai-catalog\.json$/, provider: "workbuddy-ai", label: "WorkBuddy AI（国际）", kind: "workbuddy" },
    { re: /^\.workbuddy(\d+)-catalog\.json$/, provider: (m) => `workbuddy${m[1]}`, label: (m) => `WorkBuddy 账号 ${m[1]}`, kind: "workbuddy" },
    { re: /^\.qoder-catalog\.qoder-cn\.json$/, provider: "qoder-cn", label: "Qoder（国内）", kind: "qoder" },
    { re: /^\.qoder-catalog\.qoder\.json$/, provider: "qoder", label: "Qoder（国际）", kind: "qoder" }
  ];

  for (const f of files) {
    let rule = null, m = null;
    for (const r of rules) { m = f.match(r.re); if (m) { rule = r; break; } }
    if (!rule) continue;
    let j;
    try { j = JSON.parse(readFileSync(join(home, f), "utf8")); } catch { continue; }
    const models = [];
    if (rule.kind === "qoder") {
      // entries 直接是模型数组：{id,key,name,isFree,...}
      for (const e of Array.isArray(j.entries) ? j.entries : []) {
        if (!e || !e.id) continue;
        models.push({ id: e.id, name: e.name || e.id, free: !!e.isFree });
      }
    } else {
      // entries 是单 key 对象，内层 entry.models
      const obj = j.entries && !Array.isArray(j.entries) ? Object.values(j.entries)[0] : null;
      for (const mdl of obj?.models || []) {
        if (!mdl || !mdl.id) continue;
        models.push({ id: mdl.id, name: mdl.name || mdl.id, free: !!mdl?.billing?.free });
      }
    }
    const provider = typeof rule.provider === "function" ? rule.provider(m) : rule.provider;
    const label = typeof rule.label === "function" ? rule.label(m) : rule.label;
    out.push({ kind: "local-catalog", provider, displayName: label, models });
  }
  // Trae 本地目录兜底（~/.dsh/trae/models.json，models 为模型数组 {id,name}）
  try {
    const traeFp = join(home, "trae", "models.json");
    if (existsSync(traeFp)) {
      const tj = JSON.parse(readFileSync(traeFp, "utf8"));
      const tModels = [];
      for (const mdl of Array.isArray(tj.models) ? tj.models : []) {
        if (mdl && mdl.id) tModels.push({ id: mdl.id, name: mdl.name || mdl.id, free: false });
      }
      if (tModels.length) out.push({ kind: "local-catalog", provider: "trae", displayName: "Trae（SOLO CN）", models: tModels });
    }
  } catch { /* 忽略 */ }
  return out;
}

async function fetchUpstreamModels(baseURL, apiKey) {
  const resp = await fetch(`${baseURL}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) return { error: `HTTP ${resp.status}` };
  const j = await resp.json();
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return { models: list.map((m) => ({ id: m.id, name: m.name || m.id, owned: m.owned_by || "" })) };
}
//#endregion

//#region 最小请求测试
const PROBE_TIMEOUT_MS = 10000;

async function readSnippet(resp, max) {
  try {
    const text = await resp.text();
    return text.slice(0, max);
  } catch { return ""; }
}

function validateSuccess(text) {
  if (!text.trim()) return "响应体为空";
  let j;
  try { j = JSON.parse(text); } catch { return "响应体不是合法 JSON"; }
  if (j?.error) return `响应体含错误：${(typeof j.error === "string" ? j.error : JSON.stringify(j.error)).slice(0, 200)}`;
  if (!Array.isArray(j?.choices)) return "响应缺少 choices 字段";
  return null;
}

async function probeDirect(baseURL, apiKey, modelId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
      signal: controller.signal
    });
    const latency = Date.now() - start;
    const snippet = await readSnippet(resp, resp.ok ? 4096 : 300);
    if (!resp.ok) return { status: "fail", latency, code: classifyFailure(resp.status, null, snippet), error: `HTTP ${resp.status}: ${snippet.slice(0, 200)}` };
    const problem = validateSuccess(snippet);
    return problem ? { status: "fail", latency, code: classifyFailure(200, null, snippet), error: problem } : { status: "ok", latency };
  } catch (e) {
    return { status: "fail", latency: Date.now() - start, code: classifyFailure(0, e, ""), error: e?.name === "AbortError" ? `超时（${PROBE_TIMEOUT_MS / 1e3}s）` : e?.message || String(e) };
  } finally { clearTimeout(timer); }
}
//#endregion

//#region 方案 / 链持久化（profile.dir/model-pool.json）
function dataFile(profile) {
  const dir = profile?.dir || dshHome();
  return join(dir, "model-pool.json");
}
function probeFile(profile) {
  const dir = profile?.dir || dshHome();
  return join(dir, "model-pool-probe.json");
}
function readProbe(profile) {
  const fp = probeFile(profile);
  if (!existsSync(fp)) return { results: {}, lastTestAt: null };
  try { return JSON.parse(readFileSync(fp, "utf8")) || { results: {}, lastTestAt: null }; } catch { return { results: {}, lastTestAt: null }; }
}
function writeProbe(profile, data) {
  const fp = probeFile(profile);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(data || {}, null, 2), "utf8");
}
function readState(profile) {
  const fp = dataFile(profile);
  if (!existsSync(fp)) return { activeScheme: "default", schemes: { default: { builtin: "tier", chain: [] } }, probeCache: {} };
  try { return JSON.parse(readFileSync(fp, "utf8")); } catch { return { activeScheme: "default", schemes: {}, probeCache: {} }; }
}
function writeState(profile, state) {
  const fp = dataFile(profile);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(state, null, 2), "utf8");
}
//#endregion

//#region HTTP 响应辅助
function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
function isLocalOrigin(req) {
  // webServer 仅绑定本地回环，内部面板请求的 origin 可能是 app:// 或缺省，一律放行
  const origin = String(req.headers.origin ?? "");
  if (!origin) return true;
  try { return LOCAL.has(new URL(origin).hostname.toLowerCase()); } catch { return true; }
}
async function readJsonBody(req) {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) throw new Error("Content-Type 必须是 application/json");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65536) throw new Error("请求体过大");
  }
  return body === "" ? {} : JSON.parse(body);
}
//#endregion

//#region 虚拟 provider 引擎 ModelPool/Auto
// 模块级诊断注入：apply 内赋值，供适配器内部落盘
let __poolDiag = () => {};
const POOL_PROVIDER = "ModelPool";
const POOL_MODEL = "Auto";

class PoolAdapter {
  constructor(readStateFn, getLlm) {
    this.readState = readStateFn;
    this.getLlm = getLlm;
    this.cooldown = new Map(); // selector -> untilMs
    this.lastUse = null;       // 最近一次成功命中 {scheme,provider,model,entry,at,attempts}
    this.attempts = [];        // 最近一次调用的逐条尝试记录
    this.registered = new Set(); // 宿主当前已注册 adapter 的 provider id 缓存；空=未知，不硬过滤
  }
  providerInfo(provider) { return { id: provider, name: "ModelPool" }; }
  // 虚拟模型 id 即方案名；Auto 跟随当前激活方案
  _schemeOf(model) {
    const s = this.readState();
    const schemes = s.schemes || {};
    if (model && schemes[model]) return model;
    if (s.activeScheme && schemes[s.activeScheme]) return s.activeScheme;
    return Object.keys(schemes)[0] || null;
  }
  _chainOf(model) {
    const s = this.readState();
    const name = this._schemeOf(model);
    const sc = name ? s.schemes?.[name] : null;
    return { name, chain: Array.isArray(sc?.chain) ? sc.chain : [] };
  }
  _parseEntry(entry) {
    if (!entry) return null;
    const [p, ...rest] = entry.split("/");
    return { provider: p, model: rest.join("/"), entry };
  }
  async listModels() {
    const s = this.readState();
    const schemes = s.schemes || {};
    const out = [{ provider: POOL_PROVIDER, id: POOL_MODEL, name: "ModelPool / Auto（跟随当前激活方案）" }];
    for (const [name, sc] of Object.entries(schemes)) {
      const n = Array.isArray(sc?.chain) ? sc.chain.length : 0;
      out.push({ provider: POOL_PROVIDER, id: name, name: `ModelPool / ${name}（${n} 条链）` });
    }
    return out;
  }
  async resolveModel(provider, model, signal) {
    const llm = this.getLlm();
    const head = this._head(model);
    if (head && llm?.resolveModelInfo) {
      try {
        const info = await llm.resolveModelInfo(head.provider, head.model, signal);
        return {
          provider,
          id: model,
          name: `ModelPool / ${model}`,
          ...(info.inputModalities ? { inputModalities: info.inputModalities } : {}),
          ...(info.context ? { context: info.context } : {}),
          ...(info.defaultMaxTokens !== undefined ? { defaultMaxTokens: info.defaultMaxTokens } : {})
        };
      } catch { /* 回退到简化返回 */ }
    }
    return { provider, id: model, name: `ModelPool / ${model}` };
  }
  async prepareCall(provider, model, signal) {
    __poolDiag(`[prepareCall] provider=${provider} model=${model}`);
    let modelInfo;
    try {
      modelInfo = await this.resolveModel(provider, model, signal);
    } catch (e) {
      __poolDiag(`[prepareCall] resolveModel 失败: ${e?.message}`);
      modelInfo = { provider, id: model, name: `ModelPool / ${model}` };
    }
    return {
      model: modelInfo,
      stream: (options) => this.stream(options)
    };
  }
  imageRequestTarget() { return undefined; }
  _head(model) {
    return this._parseEntry(this._chainOf(model).chain[0]);
  }
  providerRetryPolicy() {
    try {
      const head = this._head();
      const llm = this.getLlm();
      if (!head || typeof llm?.providerRetryPolicy !== "function") return undefined;
      return llm.providerRetryPolicy(head.provider);
    } catch { return undefined; }
  }
  imageRequestPricing() {
    try {
      const head = this._head();
      const llm = this.getLlm();
      if (!head || typeof llm?.imageRequestPricing !== "function") return undefined;
      return llm.imageRequestPricing(head.provider, head.model);
    } catch { return undefined; }
  }
  activeChain() {
    const s = this.readState();
    const scheme = s.schemes?.[s.activeScheme] || s.schemes?.default;
    return Array.isArray(scheme?.chain) ? scheme.chain : [];
  }
  async *stream(options) {
    const llm = this.getLlm();
    const { name: schemeName, chain } = this._chainOf(options?.model);
    __poolDiag(`[stream] enter model=${options?.model} scheme=${schemeName} chain=${chain.length}`);
    if (!llm) throw new Error("ModelPool: llm 运行时不可用");
    if (chain.length === 0) throw new Error(`ModelPool: 方案「${schemeName || "未命名"}」链路为空，请在面板勾选模型并保存`);
    const now = Date.now();
    this.attempts = [];
    // 候选：剔除冷却中
    const candidates = chain.map((entry) => {
      const [provider, ...rest] = entry.split("/");
      return { provider, model: rest.join("/"), entry };
    }).filter((c) => (this.cooldown.get(c.entry) || 0) <= now);
    let lastError;
    for (const c of candidates) {
      const attempt = { entry: c.entry, provider: c.provider, model: c.model, at: now, ok: false, error: null, skipped: false };
      this.attempts.push(attempt);
      // 已注册集合非空时，跳过宿主未注册 adapter 的 provider（如停用对接插件后的 workbuddy/workbuddy-ai）
      if (this.registered.size && !this.registered.has(c.provider)) {
        attempt.skipped = true;
        attempt.error = "宿主未注册该 provider 的 adapter";
        this.cooldown.set(c.entry, now + 300000);
        continue;
      }
      try {
        const inner = llm.stream({ ...options, provider: c.provider, model: c.model });
        // 防御：候选渠道返回非 async iterable 时，记录类型并顺延，避免直接抛 "is not a function"
        if (!inner || typeof inner[Symbol.asyncIterator] !== "function") {
          __poolDiag(`[stream] 候选 ${c.entry} 返回非流 typeof=${typeof inner} value=${String(inner).slice(0, 120)}`);
          throw new Error(`候选 ${c.entry} 返回非 async iterable（${typeof inner}）`);
        }
        const it = inner[Symbol.asyncIterator]();
        // 首帧探测：同步构造错误与首帧错误（NO_ADAPTER / 鉴权 / 限流）都在此抛出，失败即顺延
        const first = await it.next();
        attempt.ok = true;
        // 记录实际命中的供应商/模型
        this.lastUse = {
          scheme: schemeName,
          provider: c.provider,
          model: c.model,
          entry: c.entry,
          at: now,
          attempts: this.attempts.length
        };
        if (!first.done) yield first.value;
        // it 是 inner[Symbol.asyncIterator]() 返回的裸迭代器，自身无 Symbol.asyncIterator，
        // 不能再 for await(it)，否则抛 "it is not async iterable"；这里手动 while 继续消费。
        let cur = await it.next();
        while (!cur.done) {
          const chunk = cur.value;
          if (chunk.type === "finish" && chunk.reason?.kind === "error") {
            this.cooldown.set(c.entry, Date.now() + 300000);
          }
          yield chunk;
          cur = await it.next();
        }
        return;
      } catch (e) {
        lastError = e;
        attempt.error = e?.message || String(e);
        __poolDiag(`[stream] 候选 ${c.entry} 失败: ${e?.message}\n${e?.stack || ""}`);
        this.cooldown.set(c.entry, now + 300000);
        continue;
      }
    }
    __poolDiag(`[stream] 全部候选失败 lastError=${lastError?.message}`);
    throw lastError || new Error("ModelPool: 链上所有渠道均不可用");
  }
  // 刷新宿主当前已注册 adapter 的 provider 集合；路由（可 await）处调用，供发起前过滤与面板标注
  async refreshRegistered() {
    const llm = this.getLlm();
    if (!llm || typeof llm.listProviders !== "function") return;
    try {
      const provs = await llm.listProviders();
      this.registered = new Set((provs || []).map((p) => p && (p.id || p.provider)).filter(Boolean));
    } catch (e) {
      diag(`refreshRegistered 失败: ${e?.message}`);
    }
  }
  // 供面板读取：最近命中 + 本次尝试 + 冷却中条目
  status() {
    return {
      lastUse: this.lastUse,
      attempts: this.attempts,
      cooling: [...this.cooldown.entries()]
        .map(([entry, until]) => ({ entry, until, remainingMs: Math.max(0, until - Date.now()) }))
        .filter((x) => x.remainingMs > 0)
    };
  }
  async *_wrap(stream, c) {
    for await (const chunk of stream) {
      if (chunk.type === "finish" && chunk.reason?.kind === "error") {
        this.cooldown.set(c.entry, Date.now() + 300000);
      }
      yield chunk;
    }
  }
}
//#endregion

const name = "dsh-model-pool";
const inject = ["tools", "webServer", "credentials"];

function apply(ctx) {
  const diagFile = join(dshHome(), "model-pool-diag.log");
  const diag = (msg) => { try { writeFileSync(diagFile, `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" }); } catch { /* 忽略 */ } };
  __poolDiag = diag;
  const profile = ctx.get("profileContext");
  diag(`apply start; profile=${!!profile} webServer=${!!ctx.webServer} credentials=${!!ctx.credentials} llm=${!!ctx.get("llm")} logger=${!!ctx.logger}`);

  let llm = ctx.get("llm");
  const credentials = ctx.credentials; // 同步阶段捕获，避免异步请求时 inactive context 取不到
  const logger = ctx.logger ? ctx.logger("dsh-model-pool") : console;

  // 虚拟 provider 接管（llm 可选获取，注册失败不阻断面板与探测）
  const adapter = new PoolAdapter(() => readState(profile), () => llm);
  try {
    llm = llm || ctx.get("llm");
    if (llm?.registerAdapter) {
      llm.registerAdapter([POOL_PROVIDER], adapter);
      logger.info("dsh-model-pool: 虚拟 provider ModelPool/Auto 已注册");
      diag("llm.registerAdapter 成功");
    } else {
      diag("llm 暂不可用，跳过虚拟 provider 注册");
      logger.warn("dsh-model-pool: llm 暂不可用，跳过虚拟 provider 注册（探测/组链仍可用）");
    }
  } catch (e) {
    diag(`llm 注册失败: ${e?.message}\n${e?.stack || ""}`);
    logger.error("dsh-model-pool: 虚拟 provider 注册失败（不影响面板）", e);
  }

  if (!ctx.webServer) {
    diag("webServer 服务缺失，跳过 HTTP 路由注册（面板仍可加载）");
    return;
  }

  try {
  // 逐路由容错：热重载重复执行时 duplicate 路由跳过，不中断其余注册
  const reg = (opts) => { try { ctx.webServer.register(opts); diag(`route registered ${opts.path}`); } catch (e) { if (/duplicate/i.test(e?.message || "")) { diag(`route dup skip ${opts.path}`); } else throw e; } };

  // 运行时动态 adapter（qoder1/trae/workbuddy 等 registerAdapter 注册的渠道）枚举：
  // listProviders + listModels，单个 provider 失败跳过，不阻塞整体
  async function collectRuntime() {
    const out = { providers: [], rows: [] };
    const runtimeLlm = ctx.get("llm") || llm;
    if (!runtimeLlm || typeof runtimeLlm.listProviders !== "function") return out;
    let provs = [];
    try { provs = await runtimeLlm.listProviders(); } catch (e) { diag(`listProviders 失败: ${e?.message}`); return out; }
    for (const pv of provs) {
      if (!pv || pv.id === POOL_PROVIDER) continue;
      out.providers.push({ kind: "runtime", provider: pv.id, displayName: pv.name || pv.id, api: "openai-completions", runtime: true });
      let models = [];
      try { models = await runtimeLlm.listModels(pv.id) || []; }
      catch (e) { diag(`listModels ${pv.id} 失败: ${e?.message}`); continue; }
      for (const m of models) {
        if (!m || !m.id) continue;
        out.rows.push({
          key: `${pv.id}/${m.id}`,
          provider: pv.id,
          displayName: pv.name || pv.id,
          modelId: m.id,
          modelName: m.name || m.id,
          api: "runtime",
          configured: true,
          runtime: true
        });
      }
    }
    return out;
  }

  // GET /api/model-pool/providers —— 供应商清单（不含密钥）
  reg({
    kind: "exact",
    path: "/api/model-pool/providers",
    handler: async (_req, res) => {
      try {
        await adapter.refreshRegistered();
        const cfg = readSettingsCached(profile);
        const rt = await collectRuntime();
        const seen = new Set();
        const providers = [];
        for (const p of [...providerRows(cfg), ...localCatalogRows(), ...rt.providers]) {
          if (!p || seen.has(p.provider)) continue;
          seen.add(p.provider);
          providers.push(p);
        }
        sendJson(res, 200, { ok: true, providers });
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    }
  });

  // GET /api/model-pool/models —— 拉上游全目录并合并已配置模型
  reg({
    kind: "exact",
    path: "/api/model-pool/models",
    handler: async (_req, res) => {
      try {
        diag("/models hit");
        await adapter.refreshRegistered();
        const cfg = readSettingsCached(profile);
        diag(`profile keys=${profile ? Object.keys(profile).join(",") : "null"}; cfgKeys=${Object.keys(cfg).join(",")}; piAiProviders=${cfg["llm-pi-ai"]?.providers ? Object.keys(cfg["llm-pi-ai"].providers).length : 0}`);
        const map = new Map();
        const pushRow = (r) => { if (r.key && !map.has(r.key)) map.set(r.key, r); };
        // 静态 llm-pi-ai 已配置模型
        for (const p of providerRows(cfg)) {
          for (const m of p.configuredModels) {
            pushRow({
              key: `${p.provider}/${m.id}`,
              provider: p.provider,
              displayName: p.displayName,
              modelId: m.id,
              modelName: m.name || m.id,
              api: p.api,
              baseURL: p.baseURL,
              configured: true
            });
          }
        }
        // 本地 catalog：WorkBuddy（国内/国际/多账号）、Qoder（国内/国际）
        for (const w of localCatalogRows()) {
          for (const m of w.models) {
            pushRow({
              key: `${w.provider}/${m.id}`,
              provider: w.provider,
              displayName: w.displayName,
              modelId: m.id,
              modelName: m.name,
              api: "local-catalog",
              free: m.free,
              configured: true
            });
          }
        }
        // 运行时动态 adapter（qoder1/trae 等）
        const rt = await collectRuntime();
        for (const r of rt.rows) pushRow(r);
        const rows = [...map.values()];
        // 标注宿主是否已注册该 provider 的 adapter；集合未知（空）时默认可用，不误标
        for (const r of rows) r.registered = adapter.registered.size === 0 || adapter.registered.has(r.provider);
        diag(`rows=${rows.length} runtimeProviders=${rt.providers.length} rtIds=[${rt.providers.map((p) => p.provider).join(",")}]`);
        const locals = localCatalogRows();
        diag(`localCatalog=[${locals.map((l) => `${l.provider}:${l.models.length}`).join(",")}]`);
        sendJson(res, 200, { ok: true, count: rows.length, models: rows });
      } catch (e) { diag(`/models error: ${e?.message}\n${e?.stack || ""}`); sendJson(res, 500, { ok: false, error: e.message }); }
    }
  });

  // GET /api/model-pool/current —— 最近一次实际命中的供应商/模型 + 尝试与冷却
  reg({
    kind: "exact",
    path: "/api/model-pool/current",
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, { ok: true, status: typeof adapter.status === "function" ? adapter.status() : null });
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    }
  });

  // POST /api/model-pool/test {key} —— 单模型最小请求测试
  reg({
    kind: "exact",
    path: "/api/model-pool/test",
    handler: async (req, res) => {
      if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      const key = body.key;
      const cfg = readSettingsCached(profile);
      const p = providerRows(cfg).find((x) => key.startsWith(x.provider + "/"));
      if (!p) return sendJson(res, 404, { ok: false, error: "未找到该模型（workbuddy 通道见面板说明）" });
      const modelId = key.slice(p.provider.length + 1);
      if (p.api !== "openai-completions" && p.api !== "deepseek") return sendJson(res, 200, { ok: true, key, status: "skip", error: `不支持 ${p.api} 协议` });
      const apiKey = p.apiKeyEnv ? (await credentials.resolve(p.apiKeyEnv))?.value : "";
      if (!apiKey) return sendJson(res, 200, { ok: true, key, status: "fail", code: "AUTH", error: `未配置 ${p.apiKeyEnv} 的 Key` });
      const r = await probeDirect(p.baseURL, apiKey, modelId);
      sendJson(res, 200, { ok: true, key, ...r });
    }
  });

  // GET/POST /api/model-pool/probe-results —— 持久化上次连通性测试结果，下次测试前保留
  reg({
    kind: "exact",
    path: "/api/model-pool/probe-results",
    handler: async (req, res) => {
      if (req.method === "POST") {
        if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
        let body;
        try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
        writeProbe(profile, { results: body.results || {}, lastTestAt: body.lastTestAt ?? null });
        return sendJson(res, 200, { ok: true });
      }
      const data = readProbe(profile);
      sendJson(res, 200, { ok: true, results: data.results, lastTestAt: data.lastTestAt });
    }
  });

  // /api/model-pool/chain —— GET 读方案与激活链；POST 保存方案 / 切换激活（同路径按方法分发）
  reg({
    kind: "exact",
    path: "/api/model-pool/chain",
    handler: async (req, res) => {
      if (req.method === "POST") {
        if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
        let body;
        try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
        const state = readState(profile);
        if (body.activeScheme) state.activeScheme = body.activeScheme;
        if (body.schemes) state.schemes = body.schemes;
        writeState(profile, state);
        return sendJson(res, 200, { ok: true, state });
      }
      sendJson(res, 200, { ok: true, state: readState(profile) });
    }
  });

  } catch (e) {
    diag(`路由注册失败: ${e?.message}\n${e?.stack || ""}`);
    logger.error("dsh-model-pool: 路由注册失败", e);
  }

  logger.info("dsh-model-pool ready — routes /api/model-pool/* + virtual ModelPool/Auto");
}

export { apply, inject, name, TRIGGER_CODES };
