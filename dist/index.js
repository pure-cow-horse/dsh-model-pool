// dsh-model-pool host 侧（ESM，手写免构建）
// 功能1：读 llm-pi-ai providers → 拉上游 /v1/models 全目录 → 最小请求测可用性/延迟。
// 功能2：多方案（内置3 + 自定义命名链），虚拟 provider ModelPool/Auto 自带顺延引擎接管。
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
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

//#region src/usage-ledger.ts
/**
 * 每日 × 模型的 token 台账（2026-10-31）。
 *
 * ## 为什么在池子里记
 *
 * 宿主在流里发 `{ type:"usage", usage:{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? } }`，
 * 而**所有走池子的对话都经过这里**，且这一刻它明确知道是哪个渠道的哪个模型。
 * 别处都拿不到这份数据：
 *   - 会话存储只有每个会话的**累计**，没有模型维度，也不按天切；
 *   - channel-pack 的 token-ledger 只覆盖它自己的渠道；
 *   - 上游额度接口给的是"还剩多少"，不是 token 明细。
 *
 * ## 记账口径
 *
 * - `attempts` 每次发起 +1；`requests` 只在**产出正文或工具调用**后 +1，`errors` 反之。
 *   一次对话换 3 个候选才有 1 个成功，那记作 3 attempts / 1 request / 2 errors。
 * - token **只在宿主报出来时累加**：失败流通常没有 usage，就不该凭空记消耗。
 * - 缓存读单列（`cacheReadTokens`）—— 本项目实测缓存读能到输入的 10 倍量级，
 *   混进 input 会让"我用了多少"彻底失真。
 * - 按**本地时区**切天。用 UTC 的话，晚上 8 点后的用量会算到"明天"。
 *
 * ## 存储
 *
 * `~/.dsh/model-pool/usage/YYYY-MM-DD.json`，一天一个文件，原子写（tmp + rename），
 * 保留 180 天。写失败一律吞掉：记账不该有机会打扰对话。
 */
const USAGE_SCHEMA = "model-pool/usage/v1";
const USAGE_RETENTION_DAYS = 180;
const USAGE_FLUSH_MS = 1500;
const usageCache = /* @__PURE__ */ new Map();
const usageDirty = /* @__PURE__ */ new Set();
let usageFlushTimer = null;
let usagePrunedOn = "";

function usageDir() {
  return join(dshHome(), "model-pool", "usage");
}

/** 本地时区的 `YYYY-MM-DD`。 */
function usageDayKey(date = /* @__PURE__ */ new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function usageFile(day) {
  return join(usageDir(), `${day}.json`);
}

function emptyUsageEntry() {
  return { requests: 0, attempts: 0, errors: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, firstAt: "", lastAt: "" };
}

function readUsageDay(day) {
  const cached = usageCache.get(day);
  if (cached !== void 0) return cached;
  let doc = { schema: USAGE_SCHEMA, day, entries: {} };
  try {
    const raw = JSON.parse(readFileSync(usageFile(day), "utf8"));
    if (raw && raw.schema === USAGE_SCHEMA && raw.entries && typeof raw.entries === "object") doc = raw;
  } catch {
    /* 文件不存在或坏了：从空的开始。只有记账时才写，不会把旧文件覆盖成空 */
  }
  usageCache.set(day, doc);
  return doc;
}

function writeUsageDay(day, doc) {
  try {
    mkdirSync(usageDir(), { recursive: true });
    const target = usageFile(day);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 1), "utf8");
    renameSync(tmp, target);
  } catch {
    /* 记账失败不打扰对话 */
  }
}

function flushUsage() {
  if (usageFlushTimer !== null) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  for (const day of usageDirty) {
    const doc = usageCache.get(day);
    if (doc !== void 0) writeUsageDay(day, doc);
  }
  usageDirty.clear();
}

function scheduleUsageFlush() {
  if (usageFlushTimer !== null) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    flushUsage();
  }, USAGE_FLUSH_MS);
  if (typeof usageFlushTimer.unref === "function") usageFlushTimer.unref();
}

/** 只删自己写的 `YYYY-MM-DD.json`，别的一概不碰。 */
function pruneUsage(todayKey) {
  if (usagePrunedOn === todayKey) return;
  usagePrunedOn = todayKey;
  let names;
  try {
    names = readdirSync(usageDir());
  } catch {
    return;
  }
  const cutoff = /* @__PURE__ */ new Date();
  cutoff.setDate(cutoff.getDate() - USAGE_RETENTION_DAYS);
  const cutoffKey = usageDayKey(cutoff);
  for (const name of names) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/.test(name)) continue;
    if (name.slice(0, 10) >= cutoffKey) continue;
    try {
      unlinkSync(join(usageDir(), name));
    } catch {
      /* 删不掉就算了，下次再试 */
    }
  }
}

/**
 * 记一次候选尝试。返回被更新的条目，方便探针断言。
 *
 * @param input.entry - 形如 `qoder/DeepSeek-Flash` 的候选键（台账主键）。
 * @param input.usage - 宿主报的 usage；没报就是 undefined。
 * @param input.ok - 这一次是否产出了正文或工具调用。
 */
function recordPoolUsage({ entry, provider, model, scheme, usage, ok }) {
  const now = /* @__PURE__ */ new Date();
  const day = usageDayKey(now);
  pruneUsage(day);
  const doc = readUsageDay(day);
  const row = doc.entries[entry] ?? (doc.entries[entry] = emptyUsageEntry());
  row.attempts += 1;
  if (ok) row.requests += 1;
  else row.errors += 1;
  if (typeof provider === "string" && provider !== "") row.provider = provider;
  if (typeof model === "string" && model !== "") row.model = model;
  // scheme 只记"最近一次命中的方案"，不按方案分组：用户只用一个方案时它没有展示价值，
  // 但留在数据里，将来真要分组时历史数据已经带着它。
  if (typeof scheme === "string" && scheme !== "") row.scheme = scheme;
  const amount = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  if (usage !== void 0 && usage !== null) {
    row.uncachedInputTokens += amount(usage.inputTokens);
    row.outputTokens += amount(usage.outputTokens);
    row.cacheReadTokens += amount(usage.cacheReadTokens);
    row.cacheWriteTokens += amount(usage.cacheWriteTokens);
  }
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (row.firstAt === "") row.firstAt = hhmm;
  row.lastAt = hhmm;
  usageDirty.add(day);
  scheduleUsageFlush();
  return row;
}

/** 取最近 `days` 天（含今天）的台账，新到旧。 */
function usageReport(days = 7) {
  const span = Math.max(1, Math.min(90, Number(days) || 7));
  const out = [];
  for (let index = 0; index < span; index += 1) {
    const date = /* @__PURE__ */ new Date();
    date.setDate(date.getDate() - index);
    const day = usageDayKey(date);
    out.push({ day, entries: readUsageDay(day).entries });
  }
  return out;
}
//#endregion

// 渠道中心（dsh-workbuddy-trae-qoder-connect）内置默认名，与该插件 DEFAULT_REGISTRY_CHANNELS 对齐；
// 用户在面板改的名写在 $DSH_HOME/connect-channels.json，读取后覆盖这些默认值。
const DEFAULT_CHANNEL_NAMES = {
  workbuddy1: "WorkBuddy 国内",
  workbuddy2: "WorkBuddy 国内 2",
  workbuddy3: "WorkBuddy 企业版",
  workbuddy4: "WorkBuddy 国际",
  trae: "Trae",
  "qoder-cn": "Qoder 国内版",
  qoder: "Qoder 国际版"
};

// 读渠道中心注册表 {version, channels:[{id,displayName}]}，返回 providerId → 最新显示名；
// 文件缺失/损坏时回退内置默认表，保证改名即时跟随、无需重启 DSH。
function readChannelNameMap() {
  const map = new Map(Object.entries(DEFAULT_CHANNEL_NAMES));
  try {
    const fp = join(dshHome(), "connect-channels.json");
    if (existsSync(fp)) {
      const j = JSON.parse(readFileSync(fp, "utf8"));
      const channels = Array.isArray(j && j.channels) ? j.channels : [];
      for (const ch of channels) {
        if (ch && typeof ch.id === "string" && typeof ch.displayName === "string" && ch.displayName.trim()) {
          map.set(ch.id, ch.displayName.trim());
        }
      }
    }
  } catch { /* 注册表读不出就用内置默认 */ }
  return map;
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


//#region src/session-replay.ts
/**
 * 会话日志回放：补上「不经模型池」的那部分用量（2026-10-31）。
 *
 * ## 为什么还需要这一层
 *
 * 池子台账只覆盖走 `ModelPool` 的请求。用户在模型列表里**直接选某个具体模型**时，
 * 宿主绕过池子直发，池子看不见 —— 这部分占少数，但会让"每天每个模型"少一块。
 *
 * 会话日志里有完整事件流：`request/header`（`data.header.config.provider/model`）、
 * `request/context`、`assistant/message`（`data.usage` + turn/step）。所以旁路读它，
 * 就能把直连那部分补回来 —— **不进请求路径，出错最多数字不准**。
 *
 * ## 三条口径（写错就会和池子台账打架）
 *
 * 1. **跳过 `provider === "ModelPool"`**：那些请求池子台账已经记了真实候选模型，
 *    这里再记一遍就是把同一笔用量算两次。实测会话里它写作 `ModelPool/纯deepseek`
 *    （模型位放的是**方案名**，不是模型名）。
 * 2. **按 `sessionId:turn:step` 去重**：`assistant/attempt`（中途快照）与
 *    `assistant/message`（最终）可能都带 usage，后到的覆盖先到的。
 * 3. **本地时区切天**：与池子台账保持一致。
 *
 * ## 性能
 *
 * `~/.dsh/sessions` 实测 170MB / 389 个文件。所以按文件缓存 `mtime-size` 修订号，
 * 没变就不解压；只解析落在查询范围内的文件。解压走 Node 自带的
 * `zstdDecompressSync`，并按 `0xFD2FB528` magic 切**多帧**（一个文件是多帧拼接）。
 */
const SESSION_ZSTD_MAGIC = 0xFD2FB528;
const REPLAY_CACHE_TTL_MS = 30000;
const replayFiles = /* @__PURE__ */ new Map();
let replayScannedAt = 0;

function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/** 逐行折出「一次已完成调用」的记录。纯函数，探针直接喂文本。 */
function foldSessionText(text, sessionKey) {
  const records = [];
  /** `${turn}:${step}` → 记录下标；后到的（message）覆盖先到的（attempt）。 */
  const byStep = /* @__PURE__ */ new Map();
  let provider = "";
  let model = "";
  const lines = text.split("\n");
  for (const line of lines) {
    if (line === "" || line.charCodeAt(0) !== 123) continue; // 只处理以 `{` 开头的行
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    switch (event.type) {
      case "request/header": {
        const config = event.data?.header?.config;
        if (config !== undefined && config !== null) {
          if (typeof config.provider === "string") provider = config.provider;
          if (typeof config.model === "string") model = config.model;
        }
        break;
      }
      case "request/context": {
        const data = event.data;
        if (data !== undefined && data !== null) {
          if (typeof data.provider === "string") provider = data.provider;
          if (typeof data.model === "string") model = data.model;
        }
        break;
      }
      case "assistant/attempt":
      case "assistant/message": {
        const data = event.data;
        if (data === undefined || data === null) break;
        const usage = data.usage ?? lastUsageOfAttempt(data.stream);
        if (usage === undefined || usage === null) break;
        // 池子那层的用量由池子台账负责，这里跳过（见文件头口径 1）
        if (provider === "ModelPool") break;
        const record = {
          time: typeof event.time === "number" ? event.time : Date.now(),
          provider: provider === "" ? "unknown" : provider,
          model: model === "" ? "unknown" : model,
          session: sessionKey,
          turn: data.turn ?? 0,
          step: data.step ?? 0,
          usage
        };
        const key = `${record.turn}:${record.step}`;
        const existing = byStep.get(key);
        if (existing === undefined) {
          byStep.set(key, records.length);
          records.push(record);
        } else {
          records[existing] = record; // 最终值覆盖中途快照，但不会累加
        }
        break;
      }
      default:
        break;
    }
  }
  return records;
}

/** `assistant/attempt.data.stream` 里最后一个 usage 块。 */
function lastUsageOfAttempt(stream) {
  if (!Array.isArray(stream)) return void 0;
  let last;
  for (const item of stream) {
    const chunk = item?.chunk;
    if (chunk?.type === "usage" && chunk.usage !== undefined) last = chunk.usage;
  }
  return last;
}

/** 多帧 zstd：按 magic 切帧后逐帧解压。 */
function decompressSessionBuffer(buffer) {
  const starts = [];
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) === SESSION_ZSTD_MAGIC) starts.push(index);
  }
  if (starts.length === 0) return buffer.toString("utf8");
  starts.push(buffer.length);
  let text = "";
  for (let index = 0; index < starts.length - 1; index += 1) {
    try {
      text += zstdDecompressSync(buffer.subarray(starts[index], starts[index + 1])).toString("utf8");
    } catch {
      /* 单帧坏了就跳过这一帧，不让整份会话消失 */
    }
  }
  return text;
}

/** 枚举所有会话日志文件（只 stat，不读内容）。 */
function listSessionFiles() {
  const root = sessionsRoot();
  const out = [];
  let projects;
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const projectDir = join(root, project);
    let sessions;
    try {
      if (!statSync(projectDir).isDirectory()) continue;
      sessions = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const sessionDir = join(projectDir, session);
      let files;
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
        files = readdirSync(sessionDir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.startsWith("session")) continue;
        if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.zstd") && !name.endsWith(".zstd")) continue;
        const file = join(sessionDir, name);
        try {
          const stat = statSync(file);
          out.push({ file, sessionKey: session, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          /* 权限/被删：跳过 */
        }
      }
    }
  }
  return out;
}

/**
 * 回放近 `days` 天的直连用量。
 *
 * @returns `{ rows, stats }`，`rows` 是 `{ day, provider, model, requests, usage }`，
 *   `stats` 记录扫了多少文件、跳过多少、耗时，供页面上的对账区显示。
 */
function replayDirectUsage(days) {
  const now = Date.now();
  if (now - replayScannedAt < REPLAY_CACHE_TTL_MS) {
    const cached = replayCached(days);
    if (cached !== void 0) return cached;
  }
  const started = Date.now();
  const span = Math.max(1, Math.min(180, Number(days) || 7));
  const cutoffDay = (() => {
    const date = /* @__PURE__ */ new Date();
    date.setDate(date.getDate() - span + 1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  })();
  const aggregate = /* @__PURE__ */ new Map();
  const stats = { files: 0, parsed: 0, skipped: 0, failed: 0, records: 0 };
  for (const entry of listSessionFiles()) {
    stats.files += 1;
    if (entry.mtimeMs < cutoffDay) {
      stats.skipped += 1;
      continue;
    }
    const revision = `${Math.floor(entry.mtimeMs)}-${entry.size}`;
    const cached = replayFiles.get(entry.file);
    let records;
    if (cached !== void 0 && cached.revision === revision) {
      records = cached.records;
    } else {
      try {
        const text = decompressSessionBuffer(readFileSync(entry.file));
        records = foldSessionText(text, entry.sessionKey);
        replayFiles.set(entry.file, { revision, records });
        stats.parsed += 1;
      } catch {
        stats.failed += 1;
        continue;
      }
    }
    for (const record of records) {
      if (record.time < cutoffDay) continue;
      stats.records += 1;
      const day = usageDayKey(new Date(record.time));
      const key = `${day}|${record.provider}|${record.model}`;
      const row = aggregate.get(key) ?? { day, provider: record.provider, model: record.model, requests: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
      row.requests += 1;
      row.uncachedInputTokens += amountOf(record.usage.inputTokens);
      row.outputTokens += amountOf(record.usage.outputTokens);
      row.cacheReadTokens += amountOf(record.usage.cacheReadTokens);
      row.cacheWriteTokens += amountOf(record.usage.cacheWriteTokens);
      aggregate.set(key, row);
    }
  }
  const result = { rows: [...aggregate.values()], stats: { ...stats, days: span, tookMs: Date.now() - started } };
  replayScannedAt = Date.now();
  replayCache.set(span, result);
  return result;
}

const replayCache = /* @__PURE__ */ new Map();
function replayCached(days) {
  return replayCache.get(Math.max(1, Math.min(180, Number(days) || 7)));
}

function amountOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
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
// catalog 目录扫描缓存（2026-10-26 P1）：每次 /models 都要 readdir + 读 8 个 JSON，
// 面板打开、手动刷新、标签挂载会连着打好几次。10 秒 TTL 足以合并突发，又不至于看不到新目录。
const CATALOG_TTL_MS = 10000;
let catalogCache = { at: 0, rows: null };
const invalidateCatalogCache = () => { catalogCache = { at: 0, rows: null }; };

function localCatalogRows() {
  if (catalogCache.rows && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.rows;
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
  catalogCache = { at: Date.now(), rows: out };
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

/**
 * 经宿主运行时探测——给「运行时注册的渠道」用（qoder / trae / workbuddy4 等）。
 * 这些渠道没有 baseURL + apiKeyEnv 可以直连，但 `llm.stream` 走的是它们自己的
 * 适配器（协议、端点、凭据、重试全由宿主负责），所以这才是不带假阴性的口径。
 * 计时到首个产出块为止；maxTokens=1，拿到 finish 就结束。
 */
async function probeViaRuntime(llm, provider, model) {
  if (!llm || typeof llm.stream !== "function") {
    return { status: "skip", latency: 0, error: "宿主 llm 运行时不可用" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 1,
      signal: controller.signal
    });
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
      return { status: "fail", latency: 0, error: `provider ${provider} 未注册 adapter` };
    }
    let first = 0;
    for await (const chunk of stream) {
      if (chunk && chunk.type === "finish") {
        const kind = chunk.reason?.kind;
        if (kind === "error" || kind === "aborted") {
          return {
            status: "fail",
            latency: Date.now() - start,
            code: chunk.reason?.failure?.code || "ERROR",
            error: describeFailure(chunk.reason?.failure, `${provider}/${model}`)
          };
        }
        return { status: "ok", latency: first || Date.now() - start };
      }
      if (!first && chunk && chunk.type !== "usage") first = Date.now() - start;
    }
    return { status: "fail", latency: Date.now() - start, error: "流提前结束（未收到 finish）" };
  } catch (e) {
    return {
      status: "fail",
      latency: Date.now() - start,
      error: e?.name === "AbortError" ? `超时（${PROBE_TIMEOUT_MS / 1e3}s）` : e?.message || String(e)
    };
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
// 状态文件读缓存（2026-10-26 P1）：`stream()` / `listModels()` / `resolveModel()` / `status()`
// 每次都要链上配置，原来每处都是 existsSync + readFileSync + JSON.parse，
// 一轮对话要读好几次盘。用 mtime+size 做失效键，写盘时同步更新缓存。
const stateCache = new Map();
function readState(profile) {
  const fp = dataFile(profile);
  let stamp;
  try { stamp = statSync(fp); } catch { stamp = null; }
  if (!stamp) return { activeScheme: "default", schemes: { default: { builtin: "tier", chain: [] } }, probeCache: {} };
  const hit = stateCache.get(fp);
  if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) return hit.value;
  try {
    const value = JSON.parse(readFileSync(fp, "utf8"));
    stateCache.set(fp, { mtimeMs: stamp.mtimeMs, size: stamp.size, value });
    return value;
  } catch {
    return { activeScheme: "default", schemes: {}, probeCache: {} };
  }
}
function writeState(profile, state) {
  const fp = dataFile(profile);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(state, null, 2), "utf8");
  try {
    const stamp = statSync(fp);
    stateCache.set(fp, { mtimeMs: stamp.mtimeMs, size: stamp.size, value: state });
  } catch { /* 缓存更新失败不影响写盘 */ }
}

/**
 * 写 llm-pi-ai 之前备份 patch，并只保留最近 10 份（2026-10-27 A）。
 * 每次备份是一份完整 patch（约 40KB），反复接入/禁用会堆成几十个文件，
 * profile 目录越看越乱。文件名带定长毫秒时间戳，按字典序排就是时间序。
 */
const BACKUP_KEEP = 10;
function backupPatchFile(profile) {
  const patchPath = profile?.patchPath;
  if (!patchPath || !existsSync(patchPath)) return "";
  const dir = dirname(patchPath);
  const prefix = `${basename(patchPath)}.bak-modelpool-`;
  const target = `${patchPath}.bak-modelpool-${Date.now()}`;
  try { writeFileSync(target, readFileSync(patchPath)); } catch { return ""; }
  try {
    const olds = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    while (olds.length > BACKUP_KEEP) {
      const victim = olds.shift();
      try { unlinkSync(join(dir, victim)); } catch { /* 被占用就下次再清 */ }
    }
  } catch { /* 清理失败不影响备份本身 */ }
  return target;
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

/**
 * 把错误块里的 failure 压成一行人话。
 * 上游有时只给一个空的 reason（code/message/status 全无），旧代码这时会留下
 * `error: null`，面板上就是一个查不出原因的哑失败——所以这里必须有兜底文案。
 */
function describeFailure(fail, prefix) {
  const parts = [];
  if (fail && fail.code) parts.push(String(fail.code));
  if (fail && fail.status != null) parts.push(`HTTP ${fail.status}`);
  const msg = fail && typeof fail.message === "string" ? fail.message.trim() : "";
  if (msg) parts.push(msg.slice(0, 160));
  return `${prefix} ${parts.join(" ") || "错误块未附带原因（上游直接断开）"}`;
}


class PoolAdapter {
  constructor(readStateFn, getLlm) {
    this.readState = readStateFn;
    this.getLlm = getLlm;
    this.cooldown = new Map(); // selector -> untilMs
    this.lastUse = null;       // 最近一次成功命中 {scheme,provider,model,entry,at,attempts}
    this.attempts = [];        // 最近一次调用的逐条尝试记录
    this.registered = new Set(); // 宿主当前已注册 adapter 的 provider id 缓存；空=未知，不硬过滤
    // entry → { effort, until }：该渠道明确拒绝过的 reasoning 档位，10 分钟内直接跳过
    this.effortUnsupported = new Map();
    this.EFFORT_UNSUPPORTED_TTL_MS = 10 * 60 * 1000;
  }
  /**
   * 冷却时长：`state.cooldownMs` 可配，默认 60 秒（旧版两处都写死 60s，README 却写 300s）。
   * 下限 5 秒——填 0 会让失败渠道立刻回到链头反复撞墙；上限 1 小时。
   */
  _cooldownMs() {
    const raw = Number(this.readState()?.cooldownMs);
    if (!Number.isFinite(raw) || raw <= 0) return 60 * 1000;
    return Math.min(Math.max(raw, 5 * 1000), 3600 * 1000);
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
    return { name, chain: Array.isArray(sc?.chain) ? sc.chain : [], effort: sc?.effort || "" };
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
        const s = this.readState();
        const ctxWin = Number(s.contextWindow);
        let ctx = info.context;
        if (ctxWin > 0) ctx = { ...(ctx || {}), contextWindow: ctxWin }; // 用户设置覆盖模型默认上下文窗口
        return {
          provider,
          id: model,
          name: `ModelPool / ${model}`,
          ...(info.inputModalities ? { inputModalities: info.inputModalities } : {}),
          ...(ctx ? { context: ctx } : {}),
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
    const { name: schemeName, chain, effort } = this._chainOf(options?.model);
    __poolDiag(`[stream] enter model=${options?.model} scheme=${schemeName} chain=${chain.length} effort=${effort || "(跟随宿主)"}`);
    if (!llm) throw new Error("ModelPool: llm 运行时不可用");
    if (chain.length === 0) throw new Error(`ModelPool: 方案「${schemeName || "未命名"}」链路为空，请在面板勾选模型并保存`);
    const now = Date.now();
    this.attempts = [];
    // 候选：剔除冷却中
    const candidates = chain.map((entry) => {
      const [provider, ...rest] = entry.split("/");
      return { provider, model: rest.join("/"), entry };
    }).filter((c) => (this.cooldown.get(c.entry) || 0) <= now);
    __poolDiag(`[stream] 候选=${candidates.length} 冷却剔除=${chain.length - candidates.length} 顺序=${candidates.map((x) => x.entry).join(" | ")}`);
    let lastError;
    for (const c of candidates) {
      const attempt = { entry: c.entry, provider: c.provider, model: c.model, at: now, ok: false, error: null, skipped: false };
      this.attempts.push(attempt);
      __poolDiag(`[stream] 尝试 ${c.entry}`);
      // 已注册集合非空时，跳过宿主未注册 adapter 的 provider（如停用对接插件后的 workbuddy/workbuddy-ai）
      if (this.registered.size && !this.registered.has(c.provider)) {
        attempt.skipped = true;
        attempt.error = "宿主未注册该 provider 的 adapter";
        // 结构性缺失，不写冷却：每次由 registered 实时判断，插件重新启用后立即恢复
        continue;
      }
      // 第一次按方案指定强度尝试；若该渠道明确不支持此强度，自动去掉强度用其默认模式重试一次，避免误降级。
      // 已知不支持的档位先记下来（entry → {effort, until}，10 分钟过期）：方案固定
      // effort=medium 而渠道目录只有 high/max/low 时，**每一回合**都要先吃一次本地
      // 拒绝再回落（2026-10-24 实测 270 次/天），记住后直接走默认档，省掉那次空跑。
      const blockedEffort = this.effortUnsupported.get(c.entry);
      const effortBlocked = effort !== "" && blockedEffort !== void 0 && blockedEffort.effort === effort && now < blockedEffort.until;
      let variants = effort ? [effort, ""] : [""];
      if (effortBlocked) {
        variants = [""];
        __poolDiag(`[stream] ${c.entry} 跳过已知不支持的 effort=${effort}（${Math.ceil((blockedEffort.until - now) / 1000)}s 后重试），直接用渠道默认`);
      }
      let variantErr = null;
      let usedVariant = null;
      for (let vi = 0; vi < variants.length; vi++) {
        const v = variants[vi];
        try {
          __poolDiag(`[stream] ${c.entry} 尝试变体 effort=${v || "(渠道默认)"}`);
          let yieldedAny = false;
          for await (const chunk of this._attemptStream(c, options, v, attempt, schemeName, now)) {
            yieldedAny = true;
            yield chunk;
          }
          usedVariant = v;
          // 这条 (渠道, 档位) 组合这次被接受了：清掉旧记忆，目录更新后立即恢复尝试
          if (v === effort && effort !== "") this.effortUnsupported.delete(c.entry);
          break; // 成功
        } catch (e) {
          variantErr = e;
          const msg = e?.message || String(e);
          const unsupported = /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(msg);
          // 不支持当前强度且还有"去掉强度"这一备选：换变体重试，不冷却
          if (unsupported && v === effort && effort) {
            this.effortUnsupported.set(c.entry, { effort, until: now + this.EFFORT_UNSUPPORTED_TTL_MS });
            __poolDiag(`[stream] ${c.entry} 不支持 effort=${effort}，回落该渠道默认模式重试（${Math.round(this.EFFORT_UNSUPPORTED_TTL_MS / 1000)}s 内不再尝试该档位）`);
            continue;
          }
          break; // 其他错误或已试完备选：退出变体循环，走顺延
        }
      }
      if (usedVariant !== null) {
        return; // 任一变体成功，整条链路结束
      }
      // 全部变体都失败
      lastError = variantErr;
      attempt.error = variantErr?.message || String(variantErr);
      __poolDiag(`[stream] 候选 ${c.entry} 失败: ${variantErr?.message}\n${variantErr?.stack || ""}`);
      this.cooldown.set(c.entry, now + this._cooldownMs()); // 发起级失败：按配置冷却，到期回到链头
      continue;
    }
    __poolDiag(`[stream] 全部候选失败 lastError=${lastError?.message}`);
    throw lastError || new Error("ModelPool: 链上所有渠道均不可用");
  }
  // 对单条候选发起一次流式请求；effort 为空则不注入 reasoningEffort
  async *_attemptStream(c, options, effort, attempt, schemeName, now) {
    const llm = this.getLlm();
    const fwd = { ...options };
    if (effort) fwd.reasoningEffort = effort;
    const inner = llm.stream({ ...fwd, provider: c.provider, model: c.model });
    if (!inner || typeof inner[Symbol.asyncIterator] !== "function") {
      throw new Error(`候选 ${c.entry} 返回非 async iterable（${typeof inner}）`);
    }
    const it = inner[Symbol.asyncIterator]();
    const isErrFinish = (ch) => ch && ch.type === "finish" && ch.reason?.kind === "error";
    // 有产出 = 正文文本 **或** 工具调用。纯工具调用的回合没有正文，但它显然不是
    // "渠道死了"：把工具调用排除在外，会让合法的 agent 回合被判空流、渠道还被
    // 冷却 1 分钟（2026-10-24 实测：qoder-cn 一天被这样误杀 63 次，全日志 728 次，
    // workbuddy4/trae 同样中招）。chunk 类型名对照 dsh-llm：工具调用走
    // `tool-call-delta`，收尾是 `block-end` + `block.type === "tool-call"`；
    // reasoning 不算产出——只在思考中出字的渠道仍应被判失败，否则用户会看到
    // 一个没有答案的"成功"回合。
    const hasOutput = (ch) =>
      (ch.type === "text-delta" && /\S/.test(ch.text || "")) ||
      (ch.type === "block-end" && ch.block?.type === "text" && /\S/.test(ch.block.text || "")) ||
      ch.type === "tool-call-delta" ||
      (ch.type === "block-end" && (ch.block?.type === "tool-call" || ch.block?.type === "tool-result"));
    let seen = false;
    // 本次尝试宿主报出的 usage。pi-ai 适配器把它作为独立 chunk 发出来：
    // { type:"usage", usage:{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? } }
    let reported = void 0;
    try {
    let cur = await it.next();
    while (!cur.done) {
      const chunk = cur.value;
      if (chunk.type === "usage") reported = chunk.usage;
      if (isErrFinish(chunk)) {
        const fail = chunk.reason?.failure;
        __poolDiag(`[stream] ${c.entry} 错误块 code=${fail?.code || ""} seen=${seen} msg=${String(fail?.message || "").slice(0, 160)}`);
        if (!seen) throw new Error(describeFailure(fail, `${c.entry} 无正文错误`));
        // 已经产出过内容后中途断流：不能装作成功。
        // 旧版这里直接 `yield chunk; return`，既没写 attempt.error 也没写冷却
        // （本来负责这件事的 _wrap 从未被调用），面板上就留下 `ok:false / error:null`
        // 的哑失败，而且下一轮还会从这条渠道再撞一次。
        attempt.ok = false;
        attempt.midStream = true;
        attempt.error = describeFailure(fail, `${c.entry} 中途失败`);
        if (this.lastUse && this.lastUse.entry === c.entry) this.lastUse.midStreamError = attempt.error;
        this.cooldown.set(c.entry, now + this._cooldownMs());
        yield chunk;
        return;
      }
      if (hasOutput(chunk)) seen = true;
      if (!attempt.ok) {
        attempt.ok = true;
        this.lastUse = {
          scheme: schemeName,
          provider: c.provider,
          model: c.model,
          entry: c.entry,
          at: now,
          attempts: this.attempts.length
        };
      }
      yield chunk;
      cur = await it.next();
    }
    if (!seen) throw new Error(`${c.entry} 返回空流（无可见正文）`);
    } catch (error) {
      throw error;
    } finally {
      /**
       * 记账：无论成败都记一次尝试。
       *
       * `ok` 取"有没有产出正文或工具调用"——空流、首报错、被上游掐断都算失误，
       * 这跟冷却判定的口径一致（`seen`）。token 只在宿主真报了 usage 时才累加：
       * 失败流通常没有 usage，凭空补一个 0 或估算值都是在编数据。
       */
      recordPoolUsage({
        entry: c.entry,
        provider: c.provider,
        model: c.model,
        scheme: schemeName,
        usage: reported,
        ok: seen
      });
    }
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
      cooldownMs: this._cooldownMs(),
      cooling: [...this.cooldown.entries()]
        .map(([entry, until]) => ({ entry, until, remainingMs: Math.max(0, until - Date.now()) }))
        .filter((x) => x.remainingMs > 0)
    };
  }
}
//#endregion

const name = "dsh-model-pool";
const inject = ["tools", "webServer", "credentials"];

function apply(ctx) {
  const diagFile = join(dshHome(), "model-pool-diag.log");
  /**
   * 诊断日志（2026-10-26 P0）。
   *
   * 原来每行一次 `writeFileSync(..., {flag:"a"})`，而聊天标签每 3 秒就会打一次
   * `/models` 的调用日志（每次 3 行）——单文件涨到 **33.8MB / 17 万行**，其中 70%
   * 是这种无信息量的轮询记录，而且同步写在请求路径上会卡事件循环。
   *
   * 现在三条约束：
   *   1. 默认只记错误类；要看全量得显式开 `DSH_MODEL_POOL_DIAG=1`；
   *   2. 攒到 500ms 批量落地，不再一行一次同步写；
   *   3. 单文件超过 5MB 自动轮转到 `model-pool-diag.log.1`（只留一代）。
   */
  const DIAG_VERBOSE = /^(1|true|yes|on)$/i.test(String(process.env.DSH_MODEL_POOL_DIAG || ""));
  const DIAG_MAX_BYTES = 5 * 1024 * 1024;
  const DIAG_ERROR_RE = /(error|失败|异常|错误|不可用)/i;
  let diagSize = null;
  let diagQueue = [];
  let diagTimer = null;

  const flushDiag = () => {
    diagTimer = null;
    if (diagQueue.length === 0) return;
    const text = diagQueue.join("");
    diagQueue = [];
    try {
      if (diagSize === null) diagSize = existsSync(diagFile) ? statSync(diagFile).size : 0;
      if (diagSize + Buffer.byteLength(text) > DIAG_MAX_BYTES) {
        try {
          const bak = `${diagFile}.1`;
          if (existsSync(bak)) unlinkSync(bak);
          if (existsSync(diagFile)) renameSync(diagFile, bak);
        } catch { /* 轮转失败不影响主流程 */ }
        diagSize = 0;
      }
      appendFileSync(diagFile, text);
      diagSize += Buffer.byteLength(text);
    } catch { /* 诊断失败一律忽略 */ }
  };

  const diag = (msg) => {
    if (!DIAG_VERBOSE && !DIAG_ERROR_RE.test(String(msg))) return;
    diagQueue.push(`[${new Date().toISOString()}] ${msg}\n`);
    if (diagTimer) return;
    diagTimer = setTimeout(flushDiag, 500);
    if (typeof diagTimer.unref === "function") diagTimer.unref();
  };
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
  // listProviders + listModels，单个 provider 失败跳过，不阻塞整体。
  // 2026-10-26 P1：32 个 provider 逐个数模型，面板一开就是 32 次调用；加 10 秒 TTL 缓存合并突发。
  let runtimeCache = { at: 0, value: null };
  const RUNTIME_TTL_MS = 10000;
  const invalidateRuntimeCache = () => { runtimeCache = { at: 0, value: null }; };
  async function collectRuntime() {
    if (runtimeCache.value && Date.now() - runtimeCache.at < RUNTIME_TTL_MS) return runtimeCache.value;
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
    runtimeCache = { at: Date.now(), value: out };
    return out;
  }

  /**
   * 单个条目的探测分叉（2026-10-26 P1）：配置渠道直连、其余走宿主运行时。
   * 单测 `/test` 与链路自检 `/test-chain` 共用这一段——此前 `/test` 只查配置行，
   * 对 qoder / trae / workbuddy* 这类运行时注册的渠道一律 404「未找到该模型」。
   */
  const getLlm = () => llm || ctx.get("llm");

  // 设置服务（2026-10-26）：把勾选的模型写回 DSH 的 llm-pi-ai 配置。
  // 插件此前只读配置，没有任何写回能力——「选择哪些模型接入 DSH」是缺的那一环。
  let settingsSvc;
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["settings"], (sctx) => {
        settingsSvc = sctx.settings;
        return () => { settingsSvc = undefined; };
      });
    }
  } catch { /* 老宿主没有 inject 时退回 ctx.get */ }
  const getSettings = () => settingsSvc || (typeof ctx.get === "function" ? ctx.get("settings") : undefined);

  // settings.describe() 会把整份 llm-pi-ai 配置（30 个供应商 × 全部模型）序列化一遍。
  // 「测试全部」是逐个模型打 /test，每次都要查供应商定义——不缓存就是 330 次全量序列化。
  // 800ms TTL 既能合并同批请求，又不会让外部改动（在设置页改配置）看起来不生效；
  // 所有写路径必须传 force，否则会拿旧 revision 去 replace、或回读校验读到旧值。
  let piaiCache = { at: 0, value: null };
  const PIAI_TTL_MS = 800;
  const invalidatePiaiCache = () => { piaiCache = { at: 0, value: null }; };
  function piaiDescriptor(force) {
    const st = getSettings();
    if (!st || typeof st.describe !== "function") return undefined;
    const now = Date.now();
    if (!force && piaiCache.value && now - piaiCache.at < PIAI_TTL_MS) return piaiCache.value;
    let rows = [];
    try { rows = st.describe({ redactSecrets: true }) || []; } catch { return undefined; }
    const desc = rows.find((row) => row && row.ns === "llm-pi-ai");
    piaiCache = { at: now, value: desc ? { settings: st, desc } : undefined };
    return piaiCache.value;
  }

  /**
   * 供应商定义优先读**活配置**（settings.describe），文件只作兜底。
   * 因为「启用/禁用」是通过 settings.replace 改配置的，写盘与内存可能有一瞬不同步，
   * 面板必须看到宿主实际在用的那份，否则禁用了还显示、启用了还不出现。
   */
  function livePiaiSection() {
    const ready = piaiDescriptor();
    const v = ready?.desc?.value;
    if (v && typeof v === "object") return v;
    const fromFile = readSettingsCached(profile)["llm-pi-ai"];
    return fromFile && typeof fromFile === "object" ? fromFile : {};
  }
  const providerRowsLive = () => providerRows({ "llm-pi-ai": livePiaiSection() });

  /**
   * 把某供应商的模型清单整体替换为 `ids`（用户选择"按勾选整体替换"）。
   * 安全措施：写前备份 patch、按 revision 重试冲突、写后回读逐项校验。
   * 已有模型保留原有的完整对象（contextWindow / maxTokens / compat 等），
   * 只有上游新增、配置里没有的才按 `{id, name:id}` 建最小对象，交给宿主按默认处理。
   */
  async function applyModels(provider, ids) {
    const picked = Array.from(new Set((ids || []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())));
    if (picked.length === 0) throw new Error("至少要保留一个模型");
    const ready = piaiDescriptor();
    if (!ready) throw new Error("设置服务不可用或找不到 llm-pi-ai 配置段，无法写入 DSH");

    const backupPath = backupPatchFile(profile);

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      invalidatePiaiCache(); // 每轮都拿最新 revision
      const ctxReady = piaiDescriptor(true);
      if (!ctxReady) throw new Error("llm-pi-ai 配置段不可读");
      const { settings, desc } = ctxReady;
      const section = desc.value && typeof desc.value === "object" ? desc.value : {};
      const providers = { ...(section.providers || {}) };
      const current = providers[provider];
      if (!current || typeof current !== "object") throw new Error(`供应商 ${provider} 不在 llm-pi-ai 配置里`);
      const byId = new Map((Array.isArray(current.models) ? current.models : []).filter((m) => m && m.id).map((m) => [m.id, m]));
      const models = picked.map((id) => byId.get(id) || { id, name: id });
      providers[provider] = { ...current, models };
      const next = { ...section, providers };
      try {
        await settings.replace("llm-pi-ai", next, desc.revision);
      } catch (e) {
        lastError = e;
        const conflict = e?.code === "SETTINGS_CONFLICT" || e?.status === 409 || /conflict|revision/i.test(e?.message || "");
        if (conflict && attempt < 2) continue;
        throw e;
      }
      // 回读校验：宿主可能对字段做归一化，不一致就当失败报出来（备份已留）
      invalidatePiaiCache();
      const after = piaiDescriptor(true);
      const got = (after?.desc?.value?.providers?.[provider]?.models || []).map((m) => m.id);
      if (got.length !== models.length || got.some((id, i) => id !== models[i].id)) {
        throw new Error(`写入后回读不一致：期望 ${models.length} 个，实际 ${got.length} 个${backupPath ? `（可回滚：${backupPath}）` : ""}`);
      }
      // 配置变了：目录/运行时枚举的 10 秒缓存必须立刻失效，否则面板要等最多 10 秒才反映
      invalidateCatalogCache();
      invalidateRuntimeCache();
      diag(`apply-models ${provider} -> ${got.length} 个模型，备份 ${backupPath || "(无)"}`);
      return { provider, models: got, backupPath };
    }
    throw lastError || new Error("写入 llm-pi-ai 失败");
  }

  async function probeEntry(entry) {
    const raw = String(entry ?? "");
    const slash = raw.indexOf("/");
    const provider = slash > 0 ? raw.slice(0, slash) : raw;
    const modelId = slash > 0 ? raw.slice(slash + 1) : "";
    if (!modelId) {
      return { status: "skip", latency: 0, channel: "invalid", error: "模型键缺少 provider/model 结构" };
    }
    const p = providerRowsLive().find((x) => x.provider === provider);
    try {
      if (p && p.baseURL && (p.api === "openai-completions" || p.api === "deepseek")) {
        const apiKey = p.apiKeyEnv ? (await credentials.resolve(p.apiKeyEnv))?.value : "";
        if (p.apiKeyEnv && !apiKey) {
          return { status: "fail", latency: 0, code: "AUTH", channel: "direct", error: `未配置 ${p.apiKeyEnv} 的 Key` };
        }
        return { ...(await probeDirect(p.baseURL, apiKey, modelId)), channel: "direct" };
      }
      return { ...(await probeViaRuntime(getLlm(), provider, modelId)), channel: "runtime" };
    } catch (e) {
      return { status: "fail", latency: 0, channel: "error", error: e?.message || String(e) };
    }
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
        const nameByProvider = new Map(rt.providers.map((p) => [p.provider, p.displayName]));
        for (const [id, name] of readChannelNameMap()) nameByProvider.set(id, name);
        for (const p of [...providerRowsLive(), ...localCatalogRows(), ...rt.providers]) {
          if (!p || seen.has(p.provider)) continue;
          seen.add(p.provider);
          const n = nameByProvider.get(p.provider);
          if (n) p.displayName = n;
          providers.push(p);
        }
        sendJson(res, 200, { ok: true, providers });
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    }
  });

  // POST /api/model-pool/upstream {provider} —— 拉该供应商上游 /v1/models 全目录
  // 只对「配置型」渠道有效（有 baseURL + Key）；qoder / trae / workbuddy 这类运行时渠道
  // 没有可直连的上游目录，它们的模型本来就由宿主 listModels 提供。
  reg({
    kind: "exact",
    path: "/api/model-pool/upstream",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只接受 POST" });
      if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      const provider = String(body.provider || "");
      if (!provider) return sendJson(res, 400, { ok: false, error: "缺少 provider" });
      const p = providerRowsLive().find((x) => x.provider === provider);
      if (!p) return sendJson(res, 404, { ok: false, error: `${provider} 不是配置型渠道，没有可拉取的上游目录` });
      if (!p.baseURL) return sendJson(res, 400, { ok: false, error: `${provider} 未配置 baseURL` });
      if (p.api !== "openai-completions" && p.api !== "deepseek") {
        return sendJson(res, 400, { ok: false, error: `${provider} 的协议是 ${p.api}，不支持 /models 拉取` });
      }
      const apiKey = p.apiKeyEnv ? (await credentials.resolve(p.apiKeyEnv))?.value : "";
      if (p.apiKeyEnv && !apiKey) return sendJson(res, 400, { ok: false, error: `未配置 ${p.apiKeyEnv} 的 Key` });
      const r = await fetchUpstreamModels(p.baseURL, apiKey);
      if (r.error) return sendJson(res, 200, { ok: false, provider, error: `拉取失败：${r.error}` });
      const existing = p.configuredModels.map((m) => m.id);
      sendJson(res, 200, {
        ok: true,
        provider,
        models: r.models.map((m) => m.id).sort(),
        existing
      });
    }
  });

  // POST /api/model-pool/apply-models {provider, models:[id...]} —— 勾选结果写回 DSH 配置
  // 语义：整体替换该供应商的 models 清单（用户明确选择），不碰当前方案的链。
  reg({
    kind: "exact",
    path: "/api/model-pool/apply-models",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只接受 POST" });
      if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      const provider = String(body.provider || "");
      if (!provider) return sendJson(res, 400, { ok: false, error: "缺少 provider" });
      try {
        const out = await applyModels(provider, Array.isArray(body.models) ? body.models : []);
        sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e?.message || String(e) });
      }
    }
  });

  // POST /api/model-pool/toggle-provider {provider, enabled} —— 启用 / 禁用供应商
  // 宿主没有"按供应商禁用"的开关（llm-pi-ai 与 dsh-llm 里都没有这类字段），所以做法是：
  //   禁用 = 把该供应商从 llm-pi-ai.providers 摘掉，完整定义暂存到 model-pool.json；
  //          宿主随即不再为它注册 adapter → 对话的模型选择器里自然消失。
  //   启用 = 把暂存的定义原样写回。
  // 好处是 key / baseURL / 模型清单都不丢，随时可恢复；代价是会触发 llm-pi-ai 配置重载。
  reg({
    kind: "exact",
    path: "/api/model-pool/toggle-provider",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只接受 POST" });
      if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      const provider = String(body.provider || "");
      const enable = body.enabled !== false;
      if (!provider) return sendJson(res, 400, { ok: false, error: "缺少 provider" });
      if (!piaiDescriptor()) return sendJson(res, 400, { ok: false, error: "设置服务不可用或找不到 llm-pi-ai 配置段" });

      const state = readState(profile);
      const stashed = { ...(state.disabledProviders || {}) };

      // 先算一下会影响哪些链条目，回给前端提示
      const affected = [];
      for (const [name, scheme] of Object.entries(state.schemes || {})) {
        for (const entry of (scheme && Array.isArray(scheme.chain) ? scheme.chain : [])) {
          if (typeof entry === "string" && entry.startsWith(provider + "/")) affected.push(`${name}: ${entry}`);
        }
      }

      const backupPath = backupPatchFile(profile);

      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        invalidatePiaiCache();
        const current = piaiDescriptor(true);
        if (!current) return sendJson(res, 400, { ok: false, error: "llm-pi-ai 配置段不可读" });
        const section = current.desc.value && typeof current.desc.value === "object" ? current.desc.value : {};
        const providers = { ...(section.providers || {}) };

        if (enable) {
          if (providers[provider]) return sendJson(res, 200, { ok: true, provider, enabled: true, affected, already: true });
          if (!stashed[provider]) return sendJson(res, 400, { ok: false, error: `没有找到「${provider}」的暂存定义，无法恢复；请到 设置 → 模型 里重新添加` });
          providers[provider] = stashed[provider];
          delete stashed[provider];
        } else {
          if (!providers[provider]) return sendJson(res, 200, { ok: true, provider, enabled: false, affected, already: true });
          stashed[provider] = providers[provider];
          delete providers[provider];
        }

        try {
          await current.settings.replace("llm-pi-ai", { ...section, providers }, current.desc.revision);
        } catch (e) {
          lastError = e;
          const conflict = e?.code === "SETTINGS_CONFLICT" || e?.status === 409 || /conflict|revision/i.test(e?.message || "");
          if (conflict && attempt < 2) continue;
          return sendJson(res, 400, { ok: false, error: `写入 llm-pi-ai 失败：${e?.message || e}` });
        }

        invalidatePiaiCache();
        const after = piaiDescriptor(true);
        const present = Boolean(after?.desc?.value?.providers?.[provider]);
        if (present !== enable) {
          return sendJson(res, 400, {
            ok: false,
            error: `写入后回读不一致：期望${enable ? "启用" : "禁用"}，实际${present ? "启用" : "禁用"}${backupPath ? `（可回滚：${backupPath}）` : ""}`
          });
        }

        state.disabledProviders = stashed;
        writeState(profile, state);
        invalidateCatalogCache();
        invalidateRuntimeCache();
        diag(`toggle-provider ${provider} -> ${enable ? "enabled" : "disabled"}, affected=${affected.length}, backup=${backupPath || "(无)"}`);
        return sendJson(res, 200, { ok: true, provider, enabled: enable, affected, backupPath });
      }
      sendJson(res, 400, { ok: false, error: lastError?.message || "写入失败" });
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
        for (const p of providerRowsLive()) {
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
        // 分组名跟随渠道中心：runtime pv.name 打底，connect-channels.json 里用户改的名优先覆盖；
        // 这样渠道中心改名即时生效，本地硬编码名只在两处都缺失时兜底。
        const nameByProvider = new Map(rt.providers.map((p) => [p.provider, p.displayName]));
        for (const [id, name] of readChannelNameMap()) nameByProvider.set(id, name);
        for (const r of rows) {
          const n = nameByProvider.get(r.provider);
          if (n) r.displayName = n;
        }
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
  // GET /api/model-pool/usage?days=7 —— 每日 x 模型 的 token 台账（只读）
  reg({
    kind: "exact",
    path: "/api/model-pool/usage",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const days = Number(url.searchParams.get("days") || 7);
        // 池子台账（真实候选模型）+ 会话回放（直连部分）合并
        const poolDays = usageReport(days);
        const direct = replayDirectUsage(days);
        const rows = [];
        for (const day of poolDays) {
          for (const [key, entry] of Object.entries(day.entries || {})) {
            const slash = String(key).indexOf("/");
            rows.push({
              day: day.day,
              source: "pool",
              provider: entry.provider ?? (slash > 0 ? String(key).slice(0, slash) : String(key)),
              model: entry.model ?? (slash > 0 ? String(key).slice(slash + 1) : String(key)),
              requests: entry.requests ?? 0,
              errors: entry.errors ?? 0,
              uncachedInputTokens: entry.uncachedInputTokens ?? 0,
              cacheReadTokens: entry.cacheReadTokens ?? 0,
              cacheWriteTokens: entry.cacheWriteTokens ?? 0,
              outputTokens: entry.outputTokens ?? 0
            });
          }
        }
        for (const row of direct.rows) {
          rows.push({ ...row, source: "direct", errors: void 0 });
        }
        // 汇总：按天 + 总体。对账只比 token（请求数口径两边不同：池子含失败尝试）
        const byDay = /* @__PURE__ */ new Map();
        const overall = { requests: 0, errors: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
        const poolTokens = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
        const directTokens = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
        for (const row of rows) {
          const bucket = byDay.get(row.day) ?? { day: row.day, requests: 0, errors: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
          for (const field of ["requests", "errors", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"]) {
            const value = row[field] ?? 0;
            bucket[field] += value;
            overall[field] += value;
          }
          const side = row.source === "pool" ? poolTokens : directTokens;
          for (const field of ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"]) side[field] += row[field] ?? 0;
          byDay.set(row.day, bucket);
        }
        const tokenSum = (bag) => bag.uncachedInputTokens + bag.cacheReadTokens + bag.cacheWriteTokens + bag.outputTokens;
        sendJson(res, 200, {
          ok: true,
          today: usageDayKey(),
          days,
          rows,
          totals: { overall, byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) },
          reconcile: {
            poolTokens: tokenSum(poolTokens),
            directTokens: tokenSum(directTokens),
            replay: direct.stats
          }
        });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    }
  });

  reg({
    kind: "exact",
    path: "/api/model-pool/current",
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, { ok: true, status: typeof adapter.status === "function" ? adapter.status() : null });
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    }
  });

  /**
   * 预热会话回放：首次进「用量统计」要解压几十个会话文件（实测 7 天约 5.6s）。
   * 在这里后台先跑一次，用户点开页签时就已经是缓存命中。
   * `unref` 掉定时器，别让它把进程钉住。
   */
  const warmReplay = () => {
    try {
      replayDirectUsage(7);
    } catch {
      /* 预热失败无所谓，打开页签时还会再试 */
    }
  };
  const warmTimer = setTimeout(warmReplay, 4000);
  if (typeof warmTimer.unref === "function") warmTimer.unref();
  const warmInterval = setInterval(warmReplay, 10 * 60000);
  if (typeof warmInterval.unref === "function") warmInterval.unref();

  // POST /api/model-pool/test {key} —— 单模型最小请求测试
  reg({
    kind: "exact",
    path: "/api/model-pool/test",
    handler: async (req, res) => {
      if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      const key = String(body.key || "");
      if (!key) return sendJson(res, 400, { ok: false, error: "缺少 key" });
      const r = await probeEntry(key);
      sendJson(res, 200, { ok: true, key, ...r });
    }
  });

  // POST /api/model-pool/test-chain { scheme?, concurrency? } —— 只测当前（或指定）方案的链路
  // 与上面的单模型测试分开，是因为链路里常常混着运行时注册的渠道（qoder / trae /
  // workbuddy4），它们没有 baseURL + Key 可直连，只能经宿主 `llm.stream` 才算得准。
  reg({
    kind: "exact",
    path: "/api/model-pool/test-chain",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只接受 POST" });
      if (!isLocalOrigin(req)) return sendJson(res, 403, { ok: false, error: "拒绝非本地来源" });
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      const st = readState(profile);
      const schemeName = body.scheme || st.activeScheme;
      const chain = Array.isArray(st.schemes?.[schemeName]?.chain) ? st.schemes[schemeName].chain : [];
      if (chain.length === 0) {
        return sendJson(res, 200, { ok: true, scheme: schemeName, chain: [], results: {}, testedAt: Date.now() });
      }
      const results = {};
      const conc = Math.max(1, Math.min(Number(body.concurrency) || 4, 8));
      for (let i = 0; i < chain.length; i += conc) {
        await Promise.all(chain.slice(i, i + conc).map(async (entry) => {
          results[entry] = await probeEntry(entry);
        }));
      }
      sendJson(res, 200, { ok: true, scheme: schemeName, chain, results, testedAt: Date.now() });
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
        if (body.contextWindow !== undefined) state.contextWindow = body.contextWindow; // 全局上下文窗口覆盖
        if (body.cooldownMs !== undefined) state.cooldownMs = body.cooldownMs; // 失败渠道冷却时长（毫秒）
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
// 只给探针：台账的合并/切天/保留期不该只靠看界面来验。
export { recordPoolUsage as __recordPoolUsage, usageReport as __usageReport, flushUsage as __flushUsage, usageDayKey as __usageDayKey };
export { foldSessionText as __foldSessionText, decompressSessionBuffer as __decompressSessionBuffer, replayDirectUsage as __replayDirectUsage };
// 仅给探针用：_attemptStream 的"有产出"判定需要真构造 Adapter 才能测，
// 而 PoolAdapter 本身不进公共 API（DSH 只经 apply 拿到它）。
export { PoolAdapter as __PoolAdapter };
