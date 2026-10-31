// dsh-model-pool client 侧（IIFE，手写免构建）
(function () {
  let React = null;
  function provideReact(r) { React = r; }
  function getReact() { if (!React) throw new Error("[dsh-model-pool] React 未注入"); return React; }

  const NS = "model-pool";
  const t = (k) => k;

  // 左侧导航图标：数据库圆柱（模型集中成池），线性 outline 风格
  function ModelPoolIcon({ size = 16 }) {
    return React.createElement("svg", {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    },
      React.createElement("ellipse", { cx: 12, cy: 5, rx: 7, ry: 2.2 }),
      React.createElement("path", { d: "M5 5v14c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2V5" }),
      React.createElement("path", { d: "M5 12c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2" }),
      React.createElement("path", { d: "M5 18.6c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2" })
    );
  }

  // 模型族识别（用于「纯 deepseek / 纯 glm …」自定义方案）
  function familyOf(modelId) {
    const id = modelId.toLowerCase();
    if (id.includes("deepseek")) return "deepseek";
    if (id.startsWith("glm") || id.includes("glm-") || id.includes("zhipu") || id.includes("zai")) return "glm";
    if (id.includes("gemini")) return "gemini";
    if (id.includes("gpt") || id.includes("o1") || id.includes("o3") || id.includes("o4")) return "gpt";
    if (id.includes("kimi") || id.startsWith("moonshot")) return "kimi";
    if (id.includes("qwen") || id.startsWith("qwen")) return "qwen";
    if (id.includes("hy") || id.includes("hunyuan")) return "hy";
    return "other";
  }

  // 上下文窗口：数字 <-> 紧凑显示（128k / 1m）
  function fmtCtx(n) {
    n = Number(n);
    if (!n || n <= 0) return "";
    if (n >= 1e6) { const v = n / 1e6; return (Number.isInteger(v) ? v : v.toFixed(1)) + "m"; }
    if (n >= 1e3) { const v = n / 1e3; return (Number.isInteger(v) ? v : v.toFixed(1)) + "k"; }
    return String(n);
  }
  function parseCtx(s) {
    s = String(s || "").trim().toLowerCase().replace(/[\s,]/g, "");
    if (!s) return 0;
    const m = s.match(/^([\d.]+)\s*([km]?)$/);
    if (!m) return 0;
    let v = parseFloat(m[1]);
    if (!isFinite(v)) return 0;
    if (m[2] === "k") v *= 1e3;
    if (m[2] === "m") v *= 1e6;
    return Math.floor(v);
  }

  // 显示名缓存（2026-10-26 P0）：对话标签只需要 provider/model → 显示名，
  // 原实现跟着 3 秒轮询把 330 行 / 80KB 的完整清单一起拉，纯属浪费。
  // 现在清单挂载取一次、5 分钟刷新一次，跨组件重挂载也复用。
  let modelNameCache = { at: 0, map: null };
  const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
  function readModelCache(force) {
    if (force || !modelNameCache.map) return null;
    return Date.now() - modelNameCache.at > MODEL_CACHE_TTL_MS ? null : modelNameCache.map;
  }
  function writeModelCache(map) {
    modelNameCache = { at: Date.now(), map };
  }

  const styles = {
    wrap: { padding: 16, fontSize: 13, color: "var(--dsw-alias-label-primary,#333)" },
    toolbar: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 },
    btn: { height: 28, padding: "0 14px", fontSize: 12, cursor: "pointer", borderRadius: 14, border: "1px solid var(--dsw-alias-border-l2,#ddd)", background: "transparent", color: "inherit" },
    btnPrimary: { background: "var(--dsw-alias-button-primary-fill,#4f46e5)", color: "#fff", border: "none" },
    select: { height: 28, padding: "0 8px", fontSize: 12, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#ddd)" },
    search: { height: 28, width: 180, padding: "0 10px", fontSize: 12, borderRadius: 14, border: "1px solid var(--dsw-alias-border-l2,#ddd)", background: "transparent", color: "inherit" },
    notice: { fontSize: 12, marginLeft: 8 },
    noticeOk: { color: "#1a7f37" },
    noticeErr: { color: "#c0392b" },
    table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
    th: { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #eee", fontWeight: 600 },
    td: { padding: "6px 8px", borderBottom: "1px solid #f3f3f3" },
    badge: { padding: "2px 8px", borderRadius: 10, fontSize: 11 },
    ok: { background: "#e6f7ea", color: "#1a7f37" },
    fail: { background: "#fdecea", color: "#c0392b" },
    skip: { background: "#eee", color: "#666" },
    idle: { background: "#f0f0f0", color: "#888" },
    schemeBox: { marginTop: 16, padding: 12, border: "1px solid #eee", borderRadius: 10 },
    chainRow: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" },
    tabs: { display: "flex", gap: 4, borderBottom: "1px solid #eee", marginBottom: 14 },
    tabBtn: { padding: "8px 16px", cursor: "pointer", fontSize: 13, border: "none", background: "transparent", color: "#888", borderBottom: "2px solid transparent" },
    tabBtnActive: { color: "var(--dsw-alias-button-primary-fill,#4f46e5)", borderBottom: "2px solid var(--dsw-alias-button-primary-fill,#4f46e5)", fontWeight: 600 },
    chainItem: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", margin: "4px 0", border: "1px solid #eee", borderRadius: 8, background: "#fafafa", cursor: "grab" },
    dragHandle: { color: "#bbb", cursor: "grab", userSelect: "none", padding: "0 4px" },
    removeBtn: { marginLeft: "auto", border: "none", background: "transparent", color: "#c0392b", cursor: "pointer", fontSize: 12, padding: "0 6px" }
  };

  async function api(path, opts) {
    const r = await fetch(path, opts);
    return r.json();
  }

  function Section() {
    const { useState, useEffect, useRef } = getReact();
    const [models, setModels] = useState([]);
    const [results, setResults] = useState({}); // key -> {status,latency,error,code}
    const [lastTestAt, setLastTestAt] = useState(null); // 上次批量测试时间戳
    const [checked, setChecked] = useState({});
    const [filter, setFilter] = useState("all"); // all/ok/provider/family
    const [filterVal, setFilterVal] = useState("");
    const [busy, setBusy] = useState(false);
    const [showUnreg, setShowUnreg] = useState(false); // 默认隐藏未注册供应商，勾选后显示
    const [kw, setKw] = useState(""); // 模型目录搜索词
    const [refreshing, setRefreshing] = useState(false);
    const [notice, setNotice] = useState(null); // { text, type: "ok"|"err" }
    const [state, setState] = useState({ activeScheme: "default", schemes: {} });
    const [newScheme, setNewScheme] = useState("");
    const [meta, setMeta] = useState("尚未加载");
    const [collapsed, setCollapsed] = useState({}); // provider -> true 折叠
    const [expanded, setExpanded] = useState({}); // provider -> true 展开全部（默认每组只列前 20）
    const [tab, setTab] = useState("models"); // models / schemes
    const dragRef = useRef(null); // 当前拖拽的链下标
    const [current, setCurrent] = useState(null); // 最近一次实际命中
    const [ctxInput, setCtxInput] = useState(null); // 上下文窗口输入中的原始字符串（null=用紧凑显示）
    const [coolInput, setCoolInput] = useState(null); // 失败冷却秒数输入中的原始字符串
    const [chainTest, setChainTest] = useState(null); // 最近一次链路自检结果 {scheme,chain,results,testedAt}
    const [usage, setUsage] = useState(null); // 用量页：{today,days,rows,totals,reconcile}
    const [usageBusy, setUsageBusy] = useState(false);
    const [usageSpan, setUsageSpan] = useState(7); // 1 / 7 / 30
    const [sorting, setSorting] = useState({ key: "total", desc: true });
    const [upstream, setUpstream] = useState({}); // provider -> {models:[],existing:[]} | {error}
    const [upstreamSel, setUpstreamSel] = useState({}); // provider -> {modelId:boolean}
    const [upstreamBusy, setUpstreamBusy] = useState(""); // 正在拉取的 provider
    const [upstreamKw, setUpstreamKw] = useState({}); // provider -> 该目录内的搜索词（各供应商互不干扰）

    const loadModels = async (manual) => {
      if (manual) { setRefreshing(true); setNotice(null); }
      try {
        const j = await api("/api/model-pool/models");
        setMeta(`ok=${!!j.ok} models=${Array.isArray(j.models) ? j.models.length : "非数组:" + typeof j.models} count=${j.count}`);
        if (j.ok) {
          setModels(j.models || []);
          if (manual) setNotice({ text: `已更新 · ${(j.models || []).length} 个模型`, type: "ok" });
        } else if (manual) {
          setNotice({ text: j?.error || "目录返回异常", type: "err" });
        }
      } catch (e) {
        setMeta("请求异常: " + (e?.message || String(e)));
        if (manual) setNotice({ text: "刷新失败: " + (e?.message || String(e)), type: "err" });
      } finally {
        if (manual) setRefreshing(false);
      }
    };
    const loadState = async () => {
      const j = await api("/api/model-pool/chain");
      if (j.ok) setState(j.state);
    };
    const loadCurrent = async () => {
      try {
        const j = await api("/api/model-pool/current");
        if (j.ok) setCurrent(j.status);
      } catch { /* 忽略 */ }
    };
    const saveProbe = (results, lastTestAt) => {
      const body = { results };
      if (lastTestAt != null) body.lastTestAt = lastTestAt;
      api("/api/model-pool/probe-results", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
    };
    const loadProbe = async () => {
      try {
        const j = await api("/api/model-pool/probe-results");
        if (j.ok && j.results) setResults((p) => ({ ...j.results, ...p }));
        if (j.ok && j.lastTestAt) setLastTestAt(j.lastTestAt);
      } catch { /* 忽略 */ }
    };
    useEffect(() => { loadModels(); loadState(); loadCurrent(); loadProbe(); }, []);

    const testOne = async (key) => {
      const j = await api("/api/model-pool/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
      const n = { ...results, [key]: j };
      setResults(n);
      saveProbe(n);
    };
    const testAll = async () => {
      setBusy(true);
      const keys = models.map((m) => m.key);
      const out = { ...results };
      const conc = 6;
      for (let i = 0; i < keys.length; i += conc) {
        await Promise.all(keys.slice(i, i + conc).map(async (k) => {
          const j = await api("/api/model-pool/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k }) });
          out[k] = j;
        }));
      }
      setResults(out);
      const ts = Date.now();
      setLastTestAt(ts);
      saveProbe(out, ts);
      setBusy(false);
    };

    /**
     * 拉某供应商上游全目录（GET {baseURL}/models）。
     * 只有配置型渠道能拉；运行时渠道（qoder/trae/workbuddy）没有可直连的上游目录。
     */
    const pullUpstream = async (provider) => {
      setUpstreamBusy(provider);
      try {
        const j = await api("/api/model-pool/upstream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
        if (!j.ok) {
          setUpstream((p) => ({ ...p, [provider]: { error: j.error || "拉取失败" } }));
          return;
        }
        const existing = Array.isArray(j.existing) ? j.existing : [];
        const sel = {};
        for (const id of j.models) sel[id] = existing.includes(id); // 已接入的默认勾上
        setUpstreamSel((p) => ({ ...p, [provider]: sel }));
        setUpstream((p) => ({ ...p, [provider]: { models: j.models, existing } }));
      } catch (e) {
        setUpstream((p) => ({ ...p, [provider]: { error: String(e?.message || e) } }));
      } finally {
        setUpstreamBusy("");
      }
    };

    /** 把勾选结果整体写回 DSH 的 llm-pi-ai 配置（不碰链）。 */
    const applyModels = async (provider) => {
      const sel = upstreamSel[provider] || {};
      const ids = Object.keys(sel).filter((id) => sel[id]);
      if (ids.length === 0) {
        setNotice({ type: "err", text: "至少要勾选一个模型" });
        return;
      }
      const existing = upstream[provider]?.existing || [];
      const dropped = existing.filter((id) => !sel[id]);
      const warn = `将把「${provider}」的模型清单替换为 ${ids.length} 个（原来 ${existing.length} 个）` +
        (dropped.length > 0 ? `，其中 ${dropped.length} 个会被移出 DSH` : "") +
        "。当前方案的链不会改动。继续？";
      if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(warn)) return;
      setUpstreamBusy(provider);
      try {
        const j = await api("/api/model-pool/apply-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, models: ids }) });
        if (!j.ok) {
          setNotice({ type: "err", text: j.error || "写入失败" });
          return;
        }
        setNotice({ type: "ok", text: `${provider} 已接入 ${j.models.length} 个模型${j.backupPath ? "（已备份配置）" : ""}` });
        setUpstream((p) => { const n = { ...p }; delete n[provider]; return n; });
        await loadModels(true);
      } catch (e) {
        setNotice({ type: "err", text: String(e?.message || e) });
      } finally {
        setUpstreamBusy("");
      }
    };

    /**
     * 链路自检：只测「当前激活方案」链上的条目，按链顺序返回。
     * 和 testAll 的区别不只是范围——它走 /test-chain，能让运行时注册的渠道
     * （qoder / trae / workbuddy4）经宿主运行时真发一次请求，而单模型 /test 只认配置行。
     */
    const testChain = async () => {
      setBusy(true);
      setNotice(null);
      try {
        const j = await api("/api/model-pool/test-chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        if (j.ok) {
          const merged = { ...results, ...j.results };
          setResults(merged);
          setChainTest(j);
          setLastTestAt(j.testedAt);
          saveProbe(merged, j.testedAt);
        } else {
          setNotice(j.error || "链路自检失败");
        }
      } catch (e) {
        setNotice(String(e?.message || e));
      }
      setBusy(false);
    };
    const builtinRank = (kind) => {
      const sel = models.filter((m) => checked[m.key]);
      let arr = [...sel];
      if (kind === "latency") arr.sort((a, b) => (results[a.key]?.latency ?? 999999) - (results[b.key]?.latency ?? 999999));
      else if (kind === "free") arr.sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0));
      else arr.sort((a, b) => familyOf(a.modelId).localeCompare(familyOf(b.modelId))); // tier 同档聚类
      return arr.map((m) => m.key);
    };

    const saveScheme = async (name, chain) => {
      const schemes = { ...(state.schemes || {}) };
      schemes[name] = { ...(schemes[name] || {}), builtin: name === "default" ? "tier" : undefined, chain };
      const next = { ...state, schemes, activeScheme: name };
      await api("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemes, activeScheme: name }) });
      setState(next);
    };

    // 仅重排/更新当前激活方案的链路并持久化
    const persistChain = async (chain) => {
      const schemes = { ...(state.schemes || {}) };
      schemes[state.activeScheme] = { ...(schemes[state.activeScheme] || {}), chain };
      const next = { ...state, schemes, activeScheme: state.activeScheme };
      await api("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemes, activeScheme: state.activeScheme }) });
      setState(next);
    };

    // 把模型列表里勾选的模型去重追加到当前方案链末尾，不覆盖原有顺序
    const addCheckedToScheme = async () => {
      const sel = models.filter((m) => checked[m.key]).map((m) => m.key);
      if (sel.length === 0) return;
      const merged = [...activeChain];
      for (const k of sel) if (!merged.includes(k)) merged.push(k);
      persistChain(merged);
    };

    // 链拖拽排序
    const onDragStart = (i) => (e) => { dragRef.current = i; e.dataTransfer.effectAllowed = "move"; };
    const onDragOverItem = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
    const onDropItem = (i) => (e) => {
      e.preventDefault();
      const from = dragRef.current;
      dragRef.current = null;
      if (from == null || from === i) return;
      const next = [...activeChain];
      const [x] = next.splice(from, 1);
      next.splice(i, 0, x);
      persistChain(next);
    };

    const q = kw.trim().toLowerCase();
    const filtered = models.filter((m) => {
      if (!showUnreg && m.registered === false) return false; // 默认隐藏未注册供应商
      if (q) {
        const hay = [m.modelId, m.displayName, m.provider, familyOf(m.modelId)].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter === "ok" && results[m.key]?.status !== "ok") return false;
      if (filter === "provider" && m.provider !== filterVal) return false;
      if (filter === "family" && familyOf(m.modelId) !== filterVal) return false;
      return true;
    });
    // 按供应商分组（可折叠）：分组基于全量过滤结果，避免排在后面的渠道组头不出现
    const groups = {};
    for (const m of filtered) (groups[m.provider] = groups[m.provider] || []).push(m);
    const groupKeys = Object.keys(groups);
    // 搜索 / 筛选时自动展开全部分组，避免"搜到了却看不见"（原来固定只渲染前 20 个）
    const autoExpand = Boolean(q) || filter !== "all";

    const badge = (key) => {
      const r = results[key];
      const s = !r ? ["待测", styles.idle] : r.status === "ok" ? ["可用 · " + r.latency + "ms", styles.ok] : r.status === "skip" ? ["跳过", styles.skip] : ["不可用", styles.fail];
      return React.createElement("span", { style: { ...styles.badge, ...s[1] } }, s[0]);
    };

    // 上游目录面板：拉回来的全量模型清单 + 勾选 + 写回 DSH
    const upstreamPanel = (provider) => {
      const u = upstream[provider] || {};
      const sel = upstreamSel[provider] || {};
      const picked = Object.keys(sel).filter((id) => sel[id]).length;
      // 目录内搜索：各供应商一份关键词，互不干扰；只影响**显示**，不动已勾集合。
      const kw = (upstreamKw[provider] || "").trim().toLowerCase();
      const models = u.models || [];
      const visible = kw === "" ? models : models.filter((id) => String(id).toLowerCase().includes(kw));
      const visiblePicked = visible.filter((id) => sel[id]).length;
      return React.createElement("tr", { key: "up:" + provider },
        React.createElement("td", { colSpan: 7, style: { ...styles.td, background: "#fbfbfd" } },
          u.error
            ? React.createElement("div", { style: { color: "#b42318", fontSize: 12 } }, `拉取上游目录失败：${u.error}`)
            : React.createElement("div", null,
                React.createElement("div", { style: { fontSize: 12, color: "#555", marginBottom: 6 } },
                  `上游目录 ${models.length} 个 · 已接入 ${(u.existing || []).length} 个 · 已勾 ${picked} 个`,
                  kw === "" ? "" : ` · 匹配 ${visible.length} 个`),
                React.createElement("input", {
                  style: { ...styles.search, width: 280, height: 26, marginBottom: 6 },
                  placeholder: "在此目录内搜索模型 id（支持片段）",
                  value: upstreamKw[provider] || "",
                  onChange: (e) => setUpstreamKw((p) => ({ ...p, [provider]: e.target.value }))
                }),
                visible.length === 0
                  ? React.createElement("div", { style: { fontSize: 12, color: "#999", padding: "6px 0" } },
                      kw === "" ? "上游目录为空" : "无匹配的模型")
                  : React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px 14px", maxHeight: 170, overflowY: "auto", padding: "4px 0" } },
                      visible.map((id) => React.createElement("label", { key: id, style: { fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" } },
                        React.createElement("input", {
                          type: "checkbox",
                          checked: !!sel[id],
                          onChange: () => setUpstreamSel((p) => ({ ...p, [provider]: { ...(p[provider] || {}), [id]: !(p[provider] || {})[id] } }))
                        }),
                        id
                      ))
                    ),
                React.createElement("div", { style: { marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
                  React.createElement("button", {
                    style: { ...styles.btn, ...styles.btnPrimary },
                    disabled: upstreamBusy === provider || picked === 0,
                    onClick: () => applyModels(provider)
                  }, upstreamBusy === provider ? "写入中…" : `接入选中 ${picked} 个（整体替换）`),
                  // 全选/反选只作用于**当前可见**（搜索结果），且与既有选择合并
                  // —— 否则搜索后点全选会把目录里其它模型的勾选清掉。
                  React.createElement("button", {
                    style: styles.btn,
                    disabled: visible.length === 0,
                    title: kw === "" ? "勾选目录内全部模型" : "只勾选当前搜索结果",
                    onClick: () => setUpstreamSel((p) => ({ ...p, [provider]: { ...(p[provider] || {}), ...Object.fromEntries(visible.map((id) => [id, true])) } }))
                  }, kw === "" ? "全选" : `全选匹配 ${visible.length}`),
                  React.createElement("button", {
                    style: styles.btn,
                    disabled: visible.length === 0,
                    title: kw === "" ? "反转目录内全部勾选" : "只反转当前搜索结果",
                    onClick: () => setUpstreamSel((p) => ({ ...p, [provider]: { ...(p[provider] || {}), ...Object.fromEntries(visible.map((id) => [id, !(p[provider] || {})[id]])) } }))
                  }, "反选"),
                  React.createElement("button", { style: styles.btn, onClick: () => setUpstream((p) => { const n = { ...p }; delete n[provider]; return n; }) }, "收起"),
                  React.createElement("span", { style: { fontSize: 11, color: "#999" } },
                    "写回 DSH 配置，不改动当前方案的链",
                    visiblePicked > 0 && kw !== "" ? `（匹配内已勾 ${visiblePicked}）` : "")
                )
              )
        )
      );
    };

    const providers = [...new Set(models.map((m) => m.provider))];
    const families = [...new Set(models.map((m) => familyOf(m.modelId)))];
    const activeChain = state.schemes?.[state.activeScheme]?.chain || [];

    // provider/modelId → 友好显示名映射（来自模型目录），链条与当前命中不再裸露原始 id
    const modelByKey = {};
    const providerName = {};
    const nameCount = {};
    for (const m of models) {
      modelByKey[m.key] = m;
      if (!providerName[m.provider]) providerName[m.provider] = m.displayName;
      const nk = m.provider + "||" + (m.modelName || m.modelId);
      nameCount[nk] = (nameCount[nk] || 0) + 1;
    }
    // 同一供应商下模型名重复时（如普通版与 -sg 版 catalog 同名），直接用 modelId 区分，去掉重复大名
    const modelLabel = (row) => {
      const label = row.modelName || row.modelId;
      const dup = (nameCount[row.provider + "||" + label] || 0) > 1;
      return dup ? row.modelId : label;
    };
    const friendlyChain = (c) => {
      const row = modelByKey[c];
      if (row) return `${row.displayName} / ${modelLabel(row)}`;
      const idx = String(c).indexOf("/");
      if (idx > 0) {
        const pv = c.slice(0, idx), rest = c.slice(idx + 1);
        return `${providerName[pv] || pv} / ${rest}`;
      }
      return c;
    };
    const friendlyProvider = (id) => providerName[id] || id;
    const friendlyModel = (provider, modelId) => {
      const row = modelByKey[`${provider}/${modelId}`];
      return row ? (row.modelName || modelId) : modelId;
    };

    const switchScheme = async (name) => {
      await api("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeScheme: name }) });
      loadState();
    };
    const removeChainItem = (i) => {
      const next = activeChain.filter((_, j) => j !== i);
      persistChain(next);
    };

    // 未显式展开即视为折叠（打开默认全部收起）；显式 false 才是展开
    const allCollapsed = groupKeys.length > 0 && groupKeys.every((k) => collapsed[k] !== false);
    const toggleAll = () => {
      if (allCollapsed) setCollapsed(Object.fromEntries(groupKeys.map((k) => [k, false])));
      else setCollapsed(Object.fromEntries(groupKeys.map((k) => [k, true])));
    };



    //#region 用量页（B2：池子 + 会话回放合并）
    /**
     * 每日 × 模型 的 token 台账。
     *
     * 两个来源合并在宿主侧完成（`/api/model-pool/usage`）：
     *   - `pool`：走模型池的请求，模型是**真实候选**（池子转发时就知道）；
     *   - `direct`：绕过池子直接选模型的请求，从会话日志回放补回来。
     * 两者的 `ModelPool` 部分由宿主播掉，所以不会重复计数。
     */
    const usageNum = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
    const usageTotal = (row) => usageNum(row.uncachedInputTokens) + usageNum(row.cacheReadTokens) + usageNum(row.cacheWriteTokens) + usageNum(row.outputTokens);
    const fmtNum = (v) => usageNum(v).toLocaleString("zh-CN");
    const fmtCompact = (v) => {
      const n = usageNum(v);
      if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
      if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
      return String(n);
    };
    const RANGES = [[1, "今天"], [7, "近 7 天"], [30, "近 30 天"]];

    const loadUsage = async (span) => {
      const days = span ?? usageSpan;
      setUsageBusy(true);
      try {
        const response = await fetch(`/api/model-pool/usage?days=${days}`);
        const body = await response.json().catch(() => undefined);
        if (body !== undefined && body.ok === true) setUsage(body);
      } catch {
        /* 只读页面：失败就留着上一次的数据，不要清空成白板 */
      } finally {
        setUsageBusy(false);
      }
    };

    /** 一行 = 一个 (来源, 渠道, 模型)，跨天合并。 */
    const usageModelRows = (rows) => {
      const map = /* @__PURE__ */ new Map();
      for (const row of rows || []) {
        const key = `${row.source}|${row.provider}|${row.model}`;
        const acc = map.get(key) ?? { key, source: row.source, provider: row.provider, model: row.model, requests: 0, errors: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
        acc.requests += usageNum(row.requests);
        acc.errors += usageNum(row.errors);
        acc.uncachedInputTokens += usageNum(row.uncachedInputTokens);
        acc.cacheReadTokens += usageNum(row.cacheReadTokens);
        acc.cacheWriteTokens += usageNum(row.cacheWriteTokens);
        acc.outputTokens += usageNum(row.outputTokens);
        map.set(key, acc);
      }
      const list = [...map.values()];
      const pick = sorting.key;
      const dir = sorting.desc ? -1 : 1;
      const valueOf = (row) => pick === "total" ? usageTotal(row) : pick === "model" ? String(row.model) : usageNum(row[pick]);
      list.sort((a, b) => {
        const x = valueOf(a);
        const y = valueOf(b);
        if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * dir;
        return (x - y) * dir;
      });
      return list;
    };

    const exportUsage = () => {
      if (usage === null || typeof document === "undefined") return;
      const head = ["日期", "来源", "渠道", "模型", "请求", "失败", "输入(未缓存)", "缓存读", "缓存写", "输出", "合计"];
      const lines = [head.join(",")];
      for (const row of usage.rows || []) {
        lines.push([row.day, row.source === "pool" ? "池子" : "直连", row.provider, row.model,
          usageNum(row.requests), row.errors === undefined ? "" : usageNum(row.errors),
          usageNum(row.uncachedInputTokens), usageNum(row.cacheReadTokens), usageNum(row.cacheWriteTokens),
          usageNum(row.outputTokens), usageTotal(row)].join(","));
      }
      // BOM：不带的 CSV 在 Excel 里中文会乱码
      const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `模型池用量_${usage.today || "today"}_${usage.days || ""}天.csv`;
      a.click();
      URL.revokeObjectURL(url);
    };

    const sortableTh = (label, key, extraStyle) => React.createElement("th", {
      key: key,
      style: { ...styles.th, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", ...extraStyle },
      onClick: () => setSorting((prev) => prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }),
      title: "点击排序"
    }, label + (sorting.key === key ? (sorting.desc ? " ↓" : " ↑") : ""));

    const usagePane = React.createElement("div", { style: { ...styles.schemeBox, maxHeight: "calc(100vh - 150px)", overflowY: "auto" } },
      // 顶部：范围 + 动作
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" } },
        ...RANGES.map(([span, label]) => React.createElement("button", {
          key: span,
          style: { ...styles.btn, ...(usageSpan === span ? styles.btnPrimary : {}) },
          onClick: () => { setUsageSpan(span); void loadUsage(span); }
        }, label)),
        React.createElement("button", { style: styles.btn, onClick: () => void loadUsage(), disabled: usageBusy }, usageBusy ? "读取中…" : "刷新"),
        React.createElement("button", { style: styles.btn, onClick: exportUsage, disabled: usage === null }, "导出 CSV"),
        React.createElement("span", { style: { fontSize: 11, color: "#999" } }, "池子=走池子的请求；直连=直接选模型，从会话日志回放")
      ),
      usage === null
        ? React.createElement("div", { style: { color: "#888", fontSize: 12 } },
            usageBusy ? "正在回放会话日志，第一次会慢几秒…" : "还没有数据，点「刷新」读一次")
        : (() => {
            const overall = usage.totals?.overall ?? {};
            const days = usage.totals?.byDay ?? [];
            const modelRows = usageModelRows(usage.rows);
            const directCount = (usage.rows || []).filter((row) => row.source === "direct").length;
            const poolCount = (usage.rows || []).filter((row) => row.source === "pool").length;
            const replay = usage.reconcile?.replay ?? {};
            const maxDay = days.reduce((acc, day) => Math.max(acc, usageTotal(day)), 0);
            return React.createElement(React.Fragment, null,
              // ① 概览
              React.createElement("div", { style: { padding: "10px 12px", background: "#f7f8fb", border: "1px solid #e6e8ef", borderRadius: 8, marginBottom: 12 } },
                React.createElement("div", { style: { fontSize: 13, marginBottom: 4 } },
                  "请求 ", React.createElement("b", null, fmtNum(overall.requests ?? 0)),
                  " · 失败 ", React.createElement("b", { style: { color: usageNum(overall.errors) > 0 ? "#c0392b" : "inherit" } }, fmtNum(overall.errors ?? 0)),
                  " · 合计 ", React.createElement("b", null, fmtNum(usageTotal(overall))), " tokens"),
                React.createElement("div", { style: { fontSize: 12, color: "#666" } },
                  `输入 ${fmtNum(overall.uncachedInputTokens)} · 缓存读 ${fmtNum(overall.cacheReadTokens)} · 输出 ${fmtNum(overall.outputTokens)}`),
                React.createElement("div", { style: { fontSize: 11, color: "#999", marginTop: 2 } },
                  `来源：池子 ${fmtNum(poolCount)} 行 / 直连 ${fmtNum(directCount)} 行` + (typeof usage.days === "number" ? ` · 范围 ${usage.days} 天` : ""))
              ),
              // ② 按模型
              React.createElement("div", { style: { fontWeight: 600, marginBottom: 6 } }, "按模型"),
              modelRows.length === 0
                ? React.createElement("div", { style: { color: "#888", fontSize: 12, marginBottom: 12 } }, "这段时间没有记录")
                : React.createElement("table", { style: styles.table },
                    React.createElement("thead", null, React.createElement("tr", null,
                      sortableTh("模型", "model"),
                      React.createElement("th", { style: styles.th }, "来源"),
                      sortableTh("请求", "requests"),
                      sortableTh("失败", "errors"),
                      sortableTh("输入(未缓存)", "uncachedInputTokens"),
                      sortableTh("缓存读", "cacheReadTokens"),
                      sortableTh("输出", "outputTokens"),
                      sortableTh("合计", "total"))),
                    React.createElement("tbody", null, modelRows.map((row) =>
                      React.createElement("tr", { key: row.key },
                        React.createElement("td", { style: styles.td },
                          React.createElement("b", null, row.model),
                          React.createElement("span", { style: { color: "#999", marginLeft: 6, fontSize: 11 } }, row.provider)),
                        React.createElement("td", { style: styles.td },
                          React.createElement("span", { style: { ...styles.badge, ...(row.source === "pool" ? styles.ok : styles.idle) } }, row.source === "pool" ? "池子" : "直连")),
                        React.createElement("td", { style: styles.td }, fmtNum(row.requests)),
                        React.createElement("td", { style: { ...styles.td, color: row.errors > 0 ? "#c0392b" : "#999" } }, row.source === "pool" ? fmtNum(row.errors) : "—"),
                        React.createElement("td", { style: styles.td }, fmtNum(row.uncachedInputTokens)),
                        React.createElement("td", { style: styles.td }, fmtNum(row.cacheReadTokens)),
                        React.createElement("td", { style: styles.td }, fmtNum(row.outputTokens)),
                        React.createElement("td", { style: { ...styles.td, fontWeight: 600 } }, fmtNum(usageTotal(row)))
                      )))),
              // ③ 逐日
              React.createElement("div", { style: { fontWeight: 600, margin: "14px 0 6px" } }, "逐日"),
              React.createElement("table", { style: styles.table },
                React.createElement("thead", null, React.createElement("tr", null,
                  ["日期", "请求", "失败", "输入(未缓存)", "缓存读", "输出", "合计", ""].map((h) =>
                    React.createElement("th", { key: h, style: styles.th }, h)))),
                React.createElement("tbody", null, days.map((day) => {
                  const total = usageTotal(day);
                  const width = maxDay > 0 ? Math.max(2, Math.round((total / maxDay) * 100)) : 0;
                  return React.createElement("tr", { key: day.day },
                    React.createElement("td", { style: styles.td }, day.day),
                    React.createElement("td", { style: styles.td }, fmtNum(day.requests)),
                    React.createElement("td", { style: { ...styles.td, color: usageNum(day.errors) > 0 ? "#c0392b" : "#999" } }, fmtNum(day.errors)),
                    React.createElement("td", { style: styles.td }, fmtNum(day.uncachedInputTokens)),
                    React.createElement("td", { style: styles.td }, fmtNum(day.cacheReadTokens)),
                    React.createElement("td", { style: styles.td }, fmtNum(day.outputTokens)),
                    React.createElement("td", { style: { ...styles.td, fontWeight: 600 } }, fmtNum(total)),
                    React.createElement("td", { style: { ...styles.td, width: 140 } },
                      React.createElement("div", { style: { height: 6, background: "#eee", borderRadius: 3 } },
                        React.createElement("div", { style: { height: 6, width: `${width}%`, background: "#4f46e5", borderRadius: 3 } })))
                  );
                }))
              ),
              // ④ 对账
              React.createElement("div", { style: { marginTop: 14, paddingTop: 8, borderTop: "1px solid #eee", fontSize: 11, color: "#888", lineHeight: 1.7 } },
                `数据覆盖：池子 ${fmtCompact(usage.reconcile?.poolTokens ?? 0)} + 直连 ${fmtCompact(usage.reconcile?.directTokens ?? 0)} = ${fmtCompact(usageTotal(overall))} tokens`,
                React.createElement("br"),
                `回放：扫 ${fmtNum(replay.files)} 个会话文件 · 解析 ${fmtNum(replay.parsed)} · 跳过 ${fmtNum(replay.skipped)}（不在范围内）· 失败 ${fmtNum(replay.failed)} · 记录 ${fmtNum(replay.records)} 条 · 耗时 ${fmtNum(replay.tookMs)}ms`
              )
            );
          })()
    );
    //#endregion

    const tabBar = React.createElement("div", { style: styles.tabs },
      React.createElement("button", { style: { ...styles.tabBtn, ...(tab === "models" ? styles.tabBtnActive : {}) }, onClick: () => setTab("models") }, "模型列表"),
      React.createElement("button", { style: { ...styles.tabBtn, ...(tab === "schemes" ? styles.tabBtnActive : {}) }, onClick: () => setTab("schemes") }, "方案与链路"),
      React.createElement("button", {
        style: { ...styles.tabBtn, ...(tab === "usage" ? styles.tabBtnActive : {}) },
        // 第一次进页签才拉数据：它不该参与面板首屏的请求
        onClick: () => { setTab("usage"); if (usage === null) void loadUsage(usageSpan); }
      }, "用量统计")
    );

    /**
     * 启用 / 禁用供应商。
     * 禁用会把该供应商从 llm-pi-ai 配置里摘出来（定义暂存在 model-pool.json），
     * 宿主不再注册它 → 对话的模型选择列表里看不到；启用时原样写回。
     */
    const toggleProvider = async (provider, enable) => {
      const chains = [];
      for (const [name, sc] of Object.entries(state.schemes || {})) {
        for (const e of (sc?.chain || [])) if (String(e).startsWith(provider + "/")) chains.push(`${name}: ${e}`);
      }
      const tip = enable
        ? `重新启用「${provider}」？配置里的模型会回到 DSH 的模型选择列表。`
        : `禁用「${provider}」？它会从 DSH 的模型选择列表消失，配置会暂存、随时可恢复。` +
          (chains.length ? `\n\n注意：当前链上有 ${chains.length} 条引用它，禁用后这些会顺延到下一条。` : "");
      if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(tip)) return;
      try {
        const j = await api("/api/model-pool/toggle-provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, enabled: enable }) });
        if (!j.ok) {
          setNotice({ type: "err", text: j.error || "操作失败" });
          return;
        }
        setNotice({ type: "ok", text: enable ? `${provider} 已启用` : `${provider} 已禁用` });
        await loadState();
        await loadModels(true);
      } catch (e) {
        setNotice({ type: "err", text: String(e?.message || e) });
      }
    };

    const disabledProviders = Object.keys((state && state.disabledProviders) || {});
    const disabledStrip = disabledProviders.length === 0 ? null : React.createElement("div", {
      style: { marginBottom: 10, padding: "8px 10px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, fontSize: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }
    },
      React.createElement("span", { style: { color: "#9a3412", fontWeight: 600 } }, `已禁用 ${disabledProviders.length} 个供应商（不出现在对话的模型列表）`),
      ...disabledProviders.map((p) => React.createElement("span", {
        key: p,
        style: { display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid #fed7aa", borderRadius: 999, padding: "2px 8px" }
      },
        p,
        React.createElement("button", { style: { ...styles.btn, height: 22, padding: "0 8px", fontSize: 11 }, onClick: () => toggleProvider(p, true) }, "启用")
      ))
    );

    const modelsPane = React.createElement("div", null,
      disabledStrip,
      React.createElement("div", { style: styles.toolbar },
        React.createElement("button", { style: { ...styles.btn, ...styles.btnPrimary }, onClick: () => loadModels(true), disabled: refreshing }, refreshing ? "刷新中…" : "刷新目录"),
        React.createElement("button", { style: styles.btn, onClick: testAll, disabled: busy }, busy ? "测试中…" : "测试全部"),
        React.createElement("input", { style: styles.search, placeholder: "搜索模型 / 供应商 / 族", value: kw, onChange: (e) => setKw(e.target.value) }),
        React.createElement("select", { style: styles.select, value: filter, onChange: (e) => setFilter(e.target.value) },
          React.createElement("option", { value: "all" }, "全部"),
          React.createElement("option", { value: "ok" }, "仅可用"),
          React.createElement("option", { value: "provider" }, "按供应商"),
          React.createElement("option", { value: "family" }, "按模型族")
        ),
        filter !== "all" && React.createElement("select", { style: styles.select, value: filterVal, onChange: (e) => setFilterVal(e.target.value) },
          (filter === "provider" ? providers : families).map((v) => React.createElement("option", { key: v, value: v }, v))
        ),
        React.createElement("button", { style: styles.btn, onClick: toggleAll }, allCollapsed ? "全部展开" : "全部折叠"),
        React.createElement("label", { style: { fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", whiteSpace: "nowrap" } },
          React.createElement("input", { type: "checkbox", checked: showUnreg, onChange: (e) => setShowUnreg(e.target.checked) }),
          "显示未注册"
        )
      ),
      React.createElement("div", { style: { fontSize: 12, color: "#888", margin: "4px 0 10px", display: "flex", alignItems: "center", gap: 10 } },
        React.createElement("span", null, q ? `匹配 ${filtered.length} / 共 ${models.length} 个模型` : `共 ${models.length} 个模型`),
        notice && React.createElement("span", { style: { ...styles.notice, ...(notice.type === "ok" ? styles.noticeOk : styles.noticeErr) } }, notice.text),
        lastTestAt && React.createElement("span", { style: { fontSize: 12, color: "#999" }, title: new Date(lastTestAt).toLocaleString() },
          `上次测试 ${new Date(lastTestAt).toLocaleTimeString()}`)
      ),
      React.createElement("div", { style: { maxHeight: "calc(100vh - 230px)", overflowY: "auto", border: "1px solid #f0f0f0", borderRadius: 8 } },
      React.createElement("table", { style: styles.table },
        React.createElement("thead", null, React.createElement("tr", null,
          React.createElement("th", { style: styles.th }, "选"),
          React.createElement("th", { style: styles.th }, "供应商"),
          React.createElement("th", { style: styles.th }, "模型"),
          React.createElement("th", { style: styles.th }, "族"),
          React.createElement("th", { style: styles.th }, "免费"),
          React.createElement("th", { style: styles.th }, "状态"),
          React.createElement("th", { style: styles.th }, "操作")
        )),
        React.createElement("tbody", null, groupKeys.flatMap((provider) => {
          const rows = groups[provider];
          const isCol = collapsed[provider] !== false;
          const selCount = rows.filter((r) => checked[r.key]).length;
          const canPull = rows[0].api === "openai-completions" || rows[0].api === "deepseek";
          const headRow = React.createElement("tr", {
            key: "g:" + provider,
            onClick: () => setCollapsed((p) => ({ ...p, [provider]: p[provider] === false ? true : false })),
            style: { cursor: "pointer", background: "#f7f7f9", fontWeight: 600, userSelect: "none" }
          }, React.createElement("td", { colSpan: 7 },
            (isCol ? "▶ " : "▼ ") + rows[0].displayName + `（${rows.length} 个模型` + (selCount ? `，已选 ${selCount}` : "") + "）",
            canPull ? React.createElement("button", {
              style: { ...styles.btn, marginLeft: 8, padding: "0 8px", fontWeight: 400 },
              title: "拉取该供应商上游 /v1/models 全目录，勾选后写回 DSH 配置",
              disabled: upstreamBusy === provider,
              onClick: (e) => { e.stopPropagation(); pullUpstream(provider); }
            }, upstreamBusy === provider ? "拉取中…" : "拉上游") : null,
            canPull ? React.createElement("button", {
              style: { ...styles.btn, marginLeft: 6, padding: "0 8px", fontWeight: 400, color: "#9a3412" },
              title: "从 DSH 的模型选择列表里隐藏该供应商（配置会暂存，可恢复）",
              onClick: (e) => { e.stopPropagation(); toggleProvider(provider, false); }
            }, "禁用") : null
          ));
          const panel = upstream[provider] ? upstreamPanel(provider) : null;
          if (isCol) return panel ? [headRow, panel] : [headRow];
          // 每组默认只列前 20 个（330 个模型全渲染会卡），但必须给出口：
          // 原来 `rows.slice(0, 20)` 后面什么都没有，trae(31)/workbuddy-ai(28)/workbuddy4(26)
          // 有 25 个模型在面板里根本勾不到。
          const showAll = autoExpand || expanded[provider] === true;
          const shown = showAll ? rows : rows.slice(0, 20);
          const out = [headRow, ...(panel ? [panel] : []), ...shown.map((m) => {
            const unavailable = m.registered === false;
            return React.createElement("tr", { key: m.key, style: { opacity: unavailable ? 0.45 : 1 } },
              React.createElement("td", { style: styles.td }, React.createElement("input", { type: "checkbox", disabled: unavailable, checked: !!checked[m.key], onChange: () => setChecked((p) => ({ ...p, [m.key]: !p[m.key] })) })),
              React.createElement("td", { style: styles.td }, m.displayName),
              React.createElement("td", { style: styles.td }, m.modelId),
              React.createElement("td", { style: styles.td }, familyOf(m.modelId)),
              React.createElement("td", { style: styles.td }, m.free ? "是" : m.configured ? "—" : "?"),
              React.createElement("td", { style: styles.td }, badge(m.key)),
              React.createElement("td", { style: styles.td }, unavailable ? "未注册" : React.createElement("button", { style: styles.btn, onClick: () => testOne(m.key) }, "测"))
            );
          })];
          if (rows.length > 20) {
            out.push(React.createElement("tr", { key: "more:" + provider },
              React.createElement("td", { colSpan: 7, style: { ...styles.td, textAlign: "center" } },
                autoExpand
                  ? React.createElement("span", { style: { fontSize: 12, color: "#999" } }, `已展开全部 ${rows.length} 个（筛选状态）`)
                  : React.createElement("button", {
                      style: styles.btn,
                      onClick: () => setExpanded((p) => ({ ...p, [provider]: !showAll }))
                    }, showAll ? "收起，只看前 20 个" : `展开剩余 ${rows.length - 20} 个（共 ${rows.length}）`)
              )
            ));
          }
          return out;
        }))
      ),
      )
    );

    // 链路自检小结：只在「刚测过的方案」仍是当前激活方案时显示，切走就不误导
    const chainSummary = (() => {
      if (!chainTest || chainTest.scheme !== state.activeScheme) return null;
      const list = Array.isArray(chainTest.chain) ? chainTest.chain : [];
      const vals = list.map((k) => chainTest.results?.[k]).filter(Boolean);
      const okN = vals.filter((v) => v.status === "ok").length;
      const badN = vals.filter((v) => v.status === "fail").length;
      const skipN = vals.filter((v) => v.status === "skip").length;
      return React.createElement("div", { style: { marginBottom: 8, fontSize: 12, color: "#555" } },
        `链路自检 ${list.length} 条：`,
        React.createElement("b", { style: { color: "#12b76a" } }, `${okN} 可用`),
        " / ",
        React.createElement("b", { style: { color: badN > 0 ? "#f04438" : "#888" } }, `${badN} 不可用`),
        skipN > 0 ? ` / ${skipN} 跳过` : "",
        ` · ${new Date(chainTest.testedAt).toLocaleTimeString()}`
      );
    })();

    const schemesPane = React.createElement("div", { style: { ...styles.schemeBox, maxHeight: "calc(100vh - 150px)", overflowY: "auto" } },
      React.createElement("div", { style: { fontWeight: 600, marginBottom: 8 } }, "方案与链路（当前激活：" + state.activeScheme + "）"),
      React.createElement("div", { style: { margin: "0 0 10px", padding: "10px 12px", background: "#eef6ee", border: "1px solid #cde6cd", borderRadius: 8, fontSize: 13 } },
        React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, "当前实际使用",
          React.createElement("button", { style: { ...styles.btn, marginLeft: 8 }, onClick: loadCurrent }, "刷新")),
        current?.lastUse
          ? React.createElement("div", null,
              React.createElement("div", null, "供应商：", React.createElement("b", null, friendlyProvider(current.lastUse.provider)), "　模型：", React.createElement("b", null, friendlyModel(current.lastUse.provider, current.lastUse.model))),
              React.createElement("div", { style: { color: "#666", marginTop: 2 } }, `方案 ${current.lastUse.scheme} · 尝试 ${current.lastUse.attempts} 条 · ${new Date(current.lastUse.at).toLocaleTimeString()}`)
            )
          : React.createElement("div", { style: { color: "#888" } }, "尚未通过模型池发起请求"),
        current && Array.isArray(current.attempts) && current.attempts.some((a) => !a.ok)
          ? React.createElement("div", { style: { marginTop: 8, paddingTop: 6, borderTop: "1px dashed #cde6cd" } },
              React.createElement("div", { style: { fontWeight: 600, color: "#a15c00", marginBottom: 2 } }, "本次失败/跳过的渠道"),
              current.attempts.filter((a) => !a.ok).slice(-3).map((a, i) =>
                React.createElement("div", { key: "att" + i, style: { fontSize: 12, color: "#a15c00" } },
                  `${a.entry}${a.skipped ? "（跳过）" : a.midStream ? "（中途断流）" : ""}：${a.error || "未记录原因"}`)
              )
            )
          : null,
        current && Array.isArray(current.cooling) && current.cooling.length > 0
          ? React.createElement("div", { style: { marginTop: 6, fontSize: 12, color: "#666" } },
              "冷却中：" + current.cooling.map((x) => `${x.entry}（剩 ${Math.ceil(x.remainingMs / 1000)}s）`).join("、"))
          : null
      ),
      React.createElement("div", { style: { ...styles.toolbar, marginBottom: 10 } },
        React.createElement("span", { style: { fontSize: 13, color: "#555" } }, "上下文窗口（token）："),
        React.createElement("input", {
          style: { ...styles.select, width: 140 },
          type: "text",
          placeholder: "如 128k / 1m",
          value: ctxInput !== null ? ctxInput : fmtCtx(state.contextWindow),
          onChange: (e) => setCtxInput(e.target.value),
          onBlur: () => {
            const v = parseCtx(ctxInput !== null ? ctxInput : state.contextWindow);
            setCtxInput(null);
            api("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contextWindow: v }) }).then(loadState);
          }
        }),
        React.createElement("span", { style: { fontSize: 12, color: "#999" } }, "留空=跟随模型默认；支持 k/m 单位，如 128k、0.5m"),
        React.createElement("span", { style: { fontSize: 13, color: "#555", marginLeft: 10 } }, "失败冷却（秒）："),
        React.createElement("input", {
          style: { ...styles.select, width: 84 },
          type: "text",
          inputMode: "numeric",
          placeholder: "60",
          title: "失败渠道在这段时间内不参与顺延，5～3600 秒",
          value: coolInput !== null ? coolInput : String(Math.round((state.cooldownMs ?? 60000) / 1000)),
          onChange: (e) => setCoolInput(e.target.value),
          onBlur: () => {
            const raw = coolInput !== null ? coolInput : String((state.cooldownMs ?? 60000) / 1000);
            setCoolInput(null);
            const sec = Number(String(raw).trim());
            if (!Number.isFinite(sec) || sec <= 0) return; // 非法输入不写，直接回显原值
            const clamped = Math.min(Math.max(Math.round(sec), 5), 3600);
            api("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cooldownMs: clamped * 1000 }) }).then(loadState);
          }
        }),
        React.createElement("span", { style: { fontSize: 12, color: "#999" } }, "失败渠道在此期间不参与顺延")
      ),
      React.createElement("div", { style: styles.toolbar },
        React.createElement("select", { style: styles.select, value: state.activeScheme, onChange: (e) => switchScheme(e.target.value) },
          Object.keys(state.schemes || {}).map((n) => React.createElement("option", { key: n, value: n }, n))
        ),
        React.createElement("button", { style: { ...styles.btn, ...styles.btnPrimary }, onClick: testChain, disabled: busy }, busy ? "自检中…" : "测试当前链路"),
        React.createElement("button", { style: styles.btn, onClick: () => saveScheme(state.activeScheme, builtinRank("tier")) }, "同档聚类重排"),
        React.createElement("button", { style: styles.btn, onClick: () => saveScheme(state.activeScheme, builtinRank("latency")) }, "延迟优先"),
        React.createElement("button", { style: styles.btn, onClick: () => saveScheme(state.activeScheme, builtinRank("free")) }, "免费优先"),
        React.createElement("button", { style: { ...styles.btn, ...styles.btnPrimary }, onClick: addCheckedToScheme }, "+ 勾选加入当前方案"),
        React.createElement("select", {
          style: styles.select,
          title: "本方案统一思考强度；降级换供应商时强度保持一致",
          value: state.schemes?.[state.activeScheme]?.effort || "",
          onChange: (e) => {
            const schemes = { ...(state.schemes || {}) };
            schemes[state.activeScheme] = { ...(schemes[state.activeScheme] || {}), effort: e.target.value };
            api("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemes, activeScheme: state.activeScheme }) }).then(loadState);
          }
        },
          React.createElement("option", { value: "" }, "思考强度：跟随宿主"),
          React.createElement("option", { value: "minimal" }, "关闭/最低"),
          React.createElement("option", { value: "low" }, "低"),
          React.createElement("option", { value: "medium" }, "中"),
          React.createElement("option", { value: "high" }, "高")
        )
      ),
      React.createElement("div", { style: styles.toolbar },
        React.createElement("input", { style: { ...styles.select, width: 180 }, placeholder: "新方案名，如 纯 deepseek", value: newScheme, onChange: (e) => setNewScheme(e.target.value) }),
        React.createElement("button", { style: { ...styles.btn, ...styles.btnPrimary }, onClick: () => { if (newScheme) { saveScheme(newScheme, builtinRank("tier")); setNewScheme(""); } } }, "由勾选内容新建方案")
      ),
      React.createElement("div", { style: { margin: "10px 0 6px", color: "#666" } }, "当前链（" + activeChain.length + "），拖拽手柄调整顺序："),
      chainSummary,
      activeChain.map((c, i) => React.createElement("div", {
        key: i, draggable: true,
        onDragStart: onDragStart(i), onDragOver: onDragOverItem, onDrop: onDropItem(i),
        style: styles.chainItem
      },
        React.createElement("span", { style: styles.dragHandle }, "⠿"),
        React.createElement("span", { style: { color: "#999", width: 22 } }, i + 1),
        React.createElement("span", null, friendlyChain(c)),
        (() => {
          const r = results[c];
          if (!r) return null;
          const col = r.status === "ok" ? "#12b76a" : r.status === "skip" ? "#98a2b3" : "#f04438";
          const label = r.status === "ok" ? `${r.latency}ms` : r.status === "skip" ? "跳过" : "失败";
          return React.createElement("span", { style: { marginLeft: 8, fontSize: 12, color: col }, title: r.error || "" }, `● ${label}`);
        })(),
        React.createElement("button", { style: styles.removeBtn, onClick: () => removeChainItem(i) }, "移除")
      ))
    );

    return React.createElement("div", { style: styles.wrap },
      tabBar,
      tab === "models" ? modelsPane : tab === "usage" ? usagePane : schemesPane
    );
  }

  // 对话输入框模型名旁：仅当选中 ModelPool 方案时，追加显示实际命中的供应商/模型 + 紧凑思考强度切换
  function PoolLabel(props) {
    const { useState, useEffect, useRef } = getReact();
    const [use, setUse] = useState(null);
    const [byKey, setByKey] = useState({});
    const [scheme, setScheme] = useState(null);
    const useSigRef = useRef("-");
    const chainSigRef = useRef("");
    useEffect(() => {
      let alive = true;
      // 2026-10-26 P0：原来每 3 秒把 /current + /models（330 行/80KB）+ /chain 一起拉一遍，
      // 只为显示一个「供应商 / 模型」文本。现在拆成三条各自节奏：
      //   命中标签 5 秒（/current 只有 <1KB）、方案与强度 30 秒、清单 5 分钟（模块级缓存）。
      // 页面隐藏时一律跳过，避免后台标签页空转。
      const tickCurrent = async () => {
        if (document.hidden) return;
        try {
          const cj = await fetch("/api/model-pool/current", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
          if (!alive || !cj || !cj.ok) return;
          const next = cj.status?.lastUse || null;
          const sig = next ? `${next.entry}|${next.at}` : "-";
          if (sig === useSigRef.current) return; // 没变就不 setState，省掉每 5 秒一次重渲染
          useSigRef.current = sig;
          setUse(next);
        } catch { /* 忽略 */ }
      };
      const tickChain = async () => {
        if (document.hidden) return;
        try {
          const ch = await fetch("/api/model-pool/chain", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
          if (!alive || !ch || !ch.ok) return;
          const sn = ch.state?.activeScheme;
          const effort = ch.state?.schemes?.[sn]?.effort || "";
          const sig = `${sn}|${effort}`;
          if (sig === chainSigRef.current) return;
          chainSigRef.current = sig;
          setScheme({ name: sn, effort });
        } catch { /* 忽略 */ }
      };
      const loadModels = async (force) => {
        if (!force) {
          const cached = readModelCache(false);
          if (cached) { if (alive) setByKey(cached); return; }
        }
        try {
          const mj = await fetch("/api/model-pool/models", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
          if (!alive || !mj || !mj.ok || !Array.isArray(mj.models)) return;
          const map = {};
          for (const row of mj.models) map[row.key] = row;
          writeModelCache(map);
          setByKey(map);
        } catch { /* 忽略 */ }
      };
      loadModels(false);
      tickCurrent();
      tickChain();
      const tCurrent = setInterval(tickCurrent, 5000);
      const tChain = setInterval(tickChain, 30000);
      const tModels = setInterval(() => loadModels(true), MODEL_CACHE_TTL_MS);
      return () => {
        alive = false;
        clearInterval(tCurrent);
        clearInterval(tChain);
        clearInterval(tModels);
      };
    }, []);
    const name = props?.model?.name || "";
    const isPool = props?.provider?.id === "ModelPool" || props?.model?.provider === "ModelPool";
    if (!isPool) return React.createElement("span", null, name);

    const effortSelect = React.createElement("select", {
      value: scheme?.effort || "",
      title: "本方案思考强度（降级换供应商时保持一致）",
      style: { fontSize: 12, marginLeft: 8, padding: "1px 4px", border: "1px solid #d0d7de", borderRadius: 6, background: "transparent", cursor: "pointer", verticalAlign: "middle", pointerEvents: "auto" },
      onMouseDown: (e) => e.stopPropagation(),
      onClick: (e) => e.stopPropagation(),
      onKeyDown: (e) => e.stopPropagation(),
      onFocus: (e) => e.stopPropagation(),
      onChange: async (e) => {
        e.stopPropagation();
        const v = e.target.value;
        setScheme((s) => ({ ...(s || { name: "" }), effort: v }));
        try {
          const cur = await fetch("/api/model-pool/chain").then((r) => r.json());
          if (cur.ok) {
            const schemes = { ...(cur.state?.schemes || {}) };
            const sn = cur.state?.activeScheme;
            schemes[sn] = { ...(schemes[sn] || {}), effort: v };
            await fetch("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemes, activeScheme: sn }) });
          }
        } catch { /* 忽略 */ }
      }
    },
      React.createElement("option", { value: "" }, "自动"),
      React.createElement("option", { value: "minimal" }, "关"),
      React.createElement("option", { value: "low" }, "低"),
      React.createElement("option", { value: "medium" }, "中"),
      React.createElement("option", { value: "high" }, "高")
    );

    // 展开菜单(menu/option)：保持方案项原样，不放切换器
    if (props?.placement !== "trigger" || !props?.selected) return React.createElement("span", null, name);

    // 闭合按钮(trigger)：实际命中标签 + 思考强度切换
    const label = use
      ? (() => {
          const row = byKey[`${use.provider}/${use.model}`];
          const pv = row ? row.displayName : use.provider;
          const md = row ? (row.modelName || use.model) : use.model;
          return `${pv} / ${md}`;
        })()
      : name;
    return React.createElement("span", null, label, effortSelect);
  }

  const inject = ["slots", "locale"];
  function apply(ctx) {
    // 兜底：设置页里仍保留入口
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section", id: "model-pool", order: 40, label: () => "模型池", locale: NS
    }, () => React.createElement(Section)));

    // 左侧全局面板导航项（options.id 被 sidebar.panellist 读取，第二参数为图标组件）
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
      name: "sidebar.panellist", id: "model-pool", order: 50, label: () => "模型池"
    }, ModelPoolIcon));

    // 主区 keyed 面板（options.key 与 selectPanel 的 panelId 匹配）
    ctx.slots.inject("main", () => ctx.slots.register({
      name: "main", key: "model-pool", label: () => "模型池"
    }, () => React.createElement(Section)));

    // 对话输入框模型名标签：在 ModelPool 方案名后追加实际命中供应商（子槽，失败不阻断）
    try {
      ctx.slots.inject("conversation.input.model.label", () => ctx.slots.register({
        name: "conversation.input.model.label"
      }, PoolLabel));
    } catch (e) { /* 子槽契约不符时静默跳过 */ }
  }

  window.__ModuleLoader__.load({
    id: "dsh-model-pool",
    factory: (require) => {
      provideReact(require("react"));
      return { apply, inject };
    }
  });
})();
