// dsh-model-pool client 侧（IIFE，手写免构建）
(function () {
  let React = null;
  function provideReact(r) { React = r; }
  function getReact() { if (!React) throw new Error("[dsh-model-pool] React 未注入"); return React; }

  const NS = "model-pool";
  const t = (k) => k;

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

  const styles = {
    wrap: { padding: 16, fontSize: 13, color: "var(--dsw-alias-label-primary,#333)" },
    toolbar: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 },
    btn: { height: 28, padding: "0 14px", fontSize: 12, cursor: "pointer", borderRadius: 14, border: "1px solid var(--dsw-alias-border-l2,#ddd)", background: "transparent", color: "inherit" },
    btnPrimary: { background: "var(--dsw-alias-button-primary-fill,#4f46e5)", color: "#fff", border: "none" },
    select: { height: 28, padding: "0 8px", fontSize: 12, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#ddd)" },
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
    const [checked, setChecked] = useState({});
    const [filter, setFilter] = useState("all"); // all/ok/provider/family
    const [filterVal, setFilterVal] = useState("");
    const [busy, setBusy] = useState(false);
    const [state, setState] = useState({ activeScheme: "default", schemes: {} });
    const [newScheme, setNewScheme] = useState("");
    const [meta, setMeta] = useState("尚未加载");
    const [collapsed, setCollapsed] = useState({}); // provider -> true 折叠
    const [tab, setTab] = useState("models"); // models / schemes
    const dragRef = useRef(null); // 当前拖拽的链下标
    const [current, setCurrent] = useState(null); // 最近一次实际命中

    const loadModels = async () => {
      try {
        const j = await api("/api/model-pool/models");
        setMeta(`ok=${!!j.ok} models=${Array.isArray(j.models) ? j.models.length : "非数组:" + typeof j.models} count=${j.count}`);
        if (j.ok) setModels(j.models || []);
      } catch (e) {
        setMeta("请求异常: " + (e?.message || String(e)));
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
    useEffect(() => { loadModels(); loadState(); loadCurrent(); }, []);

    const testOne = async (key) => {
      const j = await api("/api/model-pool/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
      setResults((p) => ({ ...p, [key]: j }));
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
      setBusy(false);
    };

    // 内置排序方案
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
      schemes[name] = { builtin: name === "default" ? "tier" : undefined, chain };
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

    const filtered = models.filter((m) => {
      if (filter === "ok" && results[m.key]?.status !== "ok") return false;
      if (filter === "provider" && m.provider !== filterVal) return false;
      if (filter === "family" && familyOf(m.modelId) !== filterVal) return false;
      return true;
    });
    const visible = filtered.slice(0, 150); // 全量上千行会卡死，先渲染前 150 条

    // 按供应商分组（可折叠）
    const groups = {};
    for (const m of visible) (groups[m.provider] = groups[m.provider] || []).push(m);
    const groupKeys = Object.keys(groups);

    const badge = (key) => {
      const r = results[key];
      const s = !r ? ["待测", styles.idle] : r.status === "ok" ? ["可用 · " + r.latency + "ms", styles.ok] : r.status === "skip" ? ["跳过", styles.skip] : ["不可用", styles.fail];
      return React.createElement("span", { style: { ...styles.badge, ...s[1] } }, s[0]);
    };

    const providers = [...new Set(models.map((m) => m.provider))];
    const families = [...new Set(models.map((m) => familyOf(m.modelId)))];
    const activeChain = state.schemes?.[state.activeScheme]?.chain || [];

    const switchScheme = async (name) => {
      await api("/api/model-pool/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeScheme: name }) });
      loadState();
    };
    const removeChainItem = (i) => {
      const next = activeChain.filter((_, j) => j !== i);
      persistChain(next);
    };

    const allCollapsed = groupKeys.length > 0 && groupKeys.every((k) => collapsed[k]);
    const toggleAll = () => {
      if (allCollapsed) setCollapsed({});
      else setCollapsed(Object.fromEntries(groupKeys.map((k) => [k, true])));
    };

    const tabBar = React.createElement("div", { style: styles.tabs },
      React.createElement("button", { style: { ...styles.tabBtn, ...(tab === "models" ? styles.tabBtnActive : {}) }, onClick: () => setTab("models") }, "模型列表"),
      React.createElement("button", { style: { ...styles.tabBtn, ...(tab === "schemes" ? styles.tabBtnActive : {}) }, onClick: () => setTab("schemes") }, "方案与链路")
    );

    const modelsPane = React.createElement("div", null,
      React.createElement("div", { style: styles.toolbar },
        React.createElement("button", { style: { ...styles.btn, ...styles.btnPrimary }, onClick: loadModels }, "刷新目录"),
        React.createElement("button", { style: styles.btn, onClick: testAll, disabled: busy }, busy ? "测试中…" : "测试全部"),
        React.createElement("select", { style: styles.select, value: filter, onChange: (e) => setFilter(e.target.value) },
          React.createElement("option", { value: "all" }, "全部"),
          React.createElement("option", { value: "ok" }, "仅可用"),
          React.createElement("option", { value: "provider" }, "按供应商"),
          React.createElement("option", { value: "family" }, "按模型族")
        ),
        filter !== "all" && React.createElement("select", { style: styles.select, value: filterVal, onChange: (e) => setFilterVal(e.target.value) },
          (filter === "provider" ? providers : families).map((v) => React.createElement("option", { key: v, value: v }, v))
        ),
        React.createElement("button", { style: styles.btn, onClick: toggleAll }, allCollapsed ? "全部展开" : "全部折叠")
      ),
      React.createElement("div", { style: { fontSize: 12, color: "#888", margin: "4px 0 10px" } }, `共 ${models.length} 个模型`),
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
          const isCol = !!collapsed[provider];
          const selCount = rows.filter((r) => checked[r.key]).length;
          const headRow = React.createElement("tr", {
            key: "g:" + provider,
            onClick: () => setCollapsed((p) => ({ ...p, [provider]: !p[provider] })),
            style: { cursor: "pointer", background: "#f7f7f9", fontWeight: 600, userSelect: "none" }
          }, React.createElement("td", { colSpan: 7 },
            (isCol ? "▶ " : "▼ ") + rows[0].displayName + `（${rows.length} 个模型` + (selCount ? `，已选 ${selCount}` : "") + "）"
          ));
          if (isCol) return [headRow];
          return [headRow, ...rows.map((m) => React.createElement("tr", { key: m.key },
            React.createElement("td", { style: styles.td }, React.createElement("input", { type: "checkbox", checked: !!checked[m.key], onChange: () => setChecked((p) => ({ ...p, [m.key]: !p[m.key] })) })),
            React.createElement("td", { style: styles.td }, m.displayName),
            React.createElement("td", { style: styles.td }, m.modelId),
            React.createElement("td", { style: styles.td }, familyOf(m.modelId)),
            React.createElement("td", { style: styles.td }, m.free ? "是" : m.configured ? "—" : "?"),
            React.createElement("td", { style: styles.td }, badge(m.key)),
            React.createElement("td", { style: styles.td }, React.createElement("button", { style: styles.btn, onClick: () => testOne(m.key) }, "测"))
          ))];
        }))
      ),
      )
    );

    const schemesPane = React.createElement("div", { style: styles.schemeBox },
      React.createElement("div", { style: { fontWeight: 600, marginBottom: 8 } }, "方案与链路（当前激活：" + state.activeScheme + "）"),
      React.createElement("div", { style: { margin: "0 0 10px", padding: "10px 12px", background: "#eef6ee", border: "1px solid #cde6cd", borderRadius: 8, fontSize: 13 } },
        React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, "当前实际使用",
          React.createElement("button", { style: { ...styles.btn, marginLeft: 8 }, onClick: loadCurrent }, "刷新")),
        current?.lastUse
          ? React.createElement("div", null,
              React.createElement("div", null, "供应商：", React.createElement("b", null, current.lastUse.provider), "　模型：", React.createElement("b", null, current.lastUse.model)),
              React.createElement("div", { style: { color: "#666", marginTop: 2 } }, `方案 ${current.lastUse.scheme} · 尝试 ${current.lastUse.attempts} 条 · ${new Date(current.lastUse.at).toLocaleTimeString()}`)
            )
          : React.createElement("div", { style: { color: "#888" } }, "尚未通过模型池发起请求")
      ),
      React.createElement("div", { style: styles.toolbar },
        React.createElement("select", { style: styles.select, value: state.activeScheme, onChange: (e) => switchScheme(e.target.value) },
          Object.keys(state.schemes || {}).map((n) => React.createElement("option", { key: n, value: n }, n))
        ),
        React.createElement("button", { style: styles.btn, onClick: () => saveScheme(state.activeScheme, builtinRank("tier")) }, "同档聚类重排"),
        React.createElement("button", { style: styles.btn, onClick: () => saveScheme(state.activeScheme, builtinRank("latency")) }, "延迟优先"),
        React.createElement("button", { style: styles.btn, onClick: () => saveScheme(state.activeScheme, builtinRank("free")) }, "免费优先"),
        React.createElement("button", { style: { ...styles.btn, ...styles.btnPrimary }, onClick: addCheckedToScheme }, "+ 勾选加入当前方案")
      ),
      React.createElement("div", { style: styles.toolbar },
        React.createElement("input", { style: { ...styles.select, width: 180 }, placeholder: "新方案名，如 纯 deepseek", value: newScheme, onChange: (e) => setNewScheme(e.target.value) }),
        React.createElement("button", { style: { ...styles.btn, ...styles.btnPrimary }, onClick: () => { if (newScheme) { saveScheme(newScheme, builtinRank("tier")); setNewScheme(""); } } }, "由勾选内容新建方案")
      ),
      React.createElement("div", { style: { margin: "10px 0 6px", color: "#666" } }, "当前链（" + activeChain.length + "），拖拽手柄调整顺序："),
      activeChain.map((c, i) => React.createElement("div", {
        key: i, draggable: true,
        onDragStart: onDragStart(i), onDragOver: onDragOverItem, onDrop: onDropItem(i),
        style: styles.chainItem
      },
        React.createElement("span", { style: styles.dragHandle }, "⠿"),
        React.createElement("span", { style: { color: "#999", width: 22 } }, i + 1),
        React.createElement("span", null, c),
        React.createElement("button", { style: styles.removeBtn, onClick: () => removeChainItem(i) }, "移除")
      ))
    );

    return React.createElement("div", { style: styles.wrap },
      tabBar,
      tab === "models" ? modelsPane : schemesPane
    );
  }

  // 对话输入框模型名旁：仅当选中 ModelPool 方案时，追加显示实际命中的供应商/模型
  function PoolLabel(props) {
    const { useState, useEffect } = getReact();
    const [use, setUse] = useState(null);
    useEffect(() => {
      let alive = true;
      const load = async () => {
        try {
          const j = await fetch("/api/model-pool/current").then((r) => r.json());
          if (alive && j.ok) setUse(j.status?.lastUse || null);
        } catch { /* 忽略 */ }
      };
      load();
      const timer = setInterval(load, 3000);
      return () => { alive = false; clearInterval(timer); };
    }, []);
    const name = props?.model?.name || "";
    const isPool = props?.provider?.id === "ModelPool" || props?.model?.provider === "ModelPool";
    // 非 ModelPool：原样返回；展开菜单(menu/option)：显示方案原名；
    // 闭合按钮(trigger)且已有命中：直接替换为实际渠道 provider/model，未发起过则回退原名
    if (!isPool) return React.createElement("span", null, name);
    if (props?.placement === "trigger" && props?.selected && use) {
      return React.createElement("span", null, `${use.provider}/${use.model}`);
    }
    return React.createElement("span", null, name);
  }

  const inject = ["slots", "locale"];
  function apply(ctx) {
    // 兜底：设置页里仍保留入口
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section", id: "model-pool", order: 40, label: () => "模型池", locale: NS
    }, () => React.createElement(Section)));

    // 左侧全局面板导航项（options.id 被 sidebar.panellist 读取）
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
      name: "sidebar.panellist", id: "model-pool", order: 50, label: () => "模型池"
    }, () => null));

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
