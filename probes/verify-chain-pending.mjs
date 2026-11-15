/**
 * 方案与链路「测试当前链路 -> 待检查 -> 检查完毕出现结果」端到端交互校验（2026-11-11）。
 *
 * 在 Node 里挂载一份极简 React Hook 运行时 + 假 fetch，直接执行 dist/client.js，
 * 验证真实点击行为而非仅仅正则匹配：
 *   1. 点击「⚡ 测试当前链路」瞬间，当前链路上的所有模型（含已有旧结果、冷却中、待命）
 *      健康度列一律立即变成「⏳ 待检查」，主按钮禁用并展示实时进度；
 *   2. 每个模型检查完成（含冷却中的模型）即刻呈现最新检查结果（ms / 失败），未完成项仍保持「⏳ 待检查」；
 *   3. 全部完成后持久化探针结果并显示汇总。
 *
 * 用法：node probes/verify-chain-pending.mjs
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const targetFile =
  process.env.POOL_PROBE_TARGET === "installed"
    ? join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-model-pool", "dist", "client.js")
    : join(REPO, "dist", "client.js");
const src = readFileSync(targetFile, "utf8");

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

// 极简 React + DOM 树渲染器
function makeMiniReact() {
  let states = [];
  let refs = [];
  let hookIdx = 0;
  let refIdx = 0;
  let effects = [];
  let currentRootFn = null;
  let rootTree = null;

  const rerender = () => {
    hookIdx = 0;
    refIdx = 0;
    effects = [];
    rootTree = renderNode(currentRootFn());
    for (const fn of effects) fn();
  };

  const renderNode = (node) => {
    if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === "function") {
      return renderNode(node.type(node.props || {}));
    }
    return {
      ...node,
      children: (node.children || []).map(renderNode)
    };
  };

  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      const flat = [];
      const push = (arr) => {
        for (const item of arr) {
          if (Array.isArray(item)) push(item);
          else if (item !== false && item !== null && item !== undefined) flat.push(item);
        }
      };
      push(children);
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const idx = hookIdx++;
      if (!(idx in states)) states[idx] = typeof init === "function" ? init() : init;
      const set = (val) => {
        const next = typeof val === "function" ? val(states[idx]) : val;
        if (!Object.is(next, states[idx])) {
          states[idx] = next;
          rerender();
        }
      };
      return [states[idx], set];
    },
    useRef(init) {
      const idx = refIdx++;
      if (!(idx in refs)) refs[idx] = { current: init };
      return refs[idx];
    },
    useEffect(fn, deps) {
      // 仅首次挂载跑一次（本客户端只用到 []）
      const idx = hookIdx++;
      if (!(idx in states)) {
        states[idx] = deps;
        effects.push(fn);
      }
    }
  };

  return {
    React,
    mount(compFn) {
      currentRootFn = compFn;
      rerender();
    },
    getTree: () => rootTree
  };
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const x of node) findAll(x, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) findAll(c, pred, out);
  }
  return out;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") return (node.children || []).map(textOf).join("");
  return "";
}

// 可控延迟的 /api/model-pool/test 队列
const pendingDeferred = new Map();
let savedProbeCalls = [];

const mockData = {
  models: [
    { key: "p1/m1", provider: "p1", displayName: "P1", modelId: "m1", modelName: "Model 1", configured: true, free: false },
    { key: "p2/m2", provider: "p2", displayName: "P2", modelId: "m2", modelName: "Model 2", configured: true, free: true },
    { key: "p3/m3", provider: "p3", displayName: "P3", modelId: "m3", modelName: "Model 3", configured: true, free: false }
  ],
  state: {
    activeScheme: "default",
    schemes: { default: { chain: ["p1/m1", "p2/m2", "p3/m3"] } },
    cooldownMs: 60000
  },
  current: {
    lastUse: null,
    attempts: [],
    cooling: [{ entry: "p2/m2", until: Date.now() + 45000, remainingMs: 45000, streak: 1 }]
  },
  probe: {
    results: { "p1/m1": { status: "ok", latency: 420 } },
    lastTestAt: Date.now() - 10000
  }
};

const fakeFetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  let json;
  if (url === "/api/model-pool/models") json = { ok: true, models: mockData.models, count: mockData.models.length };
  else if (url === "/api/model-pool/chain") json = { ok: true, state: mockData.state };
  else if (url === "/api/model-pool/current") json = { ok: true, status: mockData.current };
  else if (url === "/api/model-pool/probe-results") {
    if (opts?.method === "POST") {
      savedProbeCalls.push(body);
      json = { ok: true };
    } else {
      json = { ok: true, results: mockData.probe.results, lastTestAt: mockData.probe.lastTestAt };
    }
  } else if (url === "/api/model-pool/test") {
    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });
    pendingDeferred.set(body.key, resolveFn);
    json = await promise;
  } else {
    json = { ok: true };
  }
  return { json: async () => json };
};

const { React, mount, getTree } = makeMiniReact();
let loadedMod = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ factory }) {
        loadedMod = factory((name) => (name === "react" ? React : {}));
      }
    }
  },
  fetch: fakeFetch,
  localStorage: { getItem: () => null, setItem: () => {} },
  console,
  Date,
  Math,
  Number,
  String,
  Array,
  Object,
  JSON,
  Set,
  Map,
  Promise,
  Error,
  RegExp,
  parseInt,
  setTimeout
};
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox, { filename: targetFile });

let mainSlotFactory = null;
const fakeCtx = {
  slots: {
    inject(_name, fn) { fn(); },
    register(def, comp) {
      if (def.name === "main" && def.key === "model-pool") mainSlotFactory = comp;
    }
  }
};
loadedMod.apply(fakeCtx);

console.log("model-pool 方案链路「待检查 -> 出现结果」交互验证");
ok("client.js 成功注册 main 面板", typeof mainSlotFactory === "function");

mount(mainSlotFactory);
await new Promise((r) => setTimeout(r, 20)); // 等待初始 useEffect fetch 完成

// 切换到「方案与链路」页签
const schemeTabBtn = findAll(getTree(), (n) => n.type === "button" && textOf(n).includes("方案与链路"))[0];
ok("找到「方案与链路」页签按钮", Boolean(schemeTabBtn));
schemeTabBtn.props.onClick();

const getRows = () => {
  const tbody = findAll(getTree(), (n) => n.type === "tbody")[0];
  return tbody ? tbody.children : [];
};
const rowTexts = () => getRows().map((tr) => textOf(tr));

ok("初始渲染 3 条链路模型", getRows().length === 3, `rows=${getRows().length}`);
ok("初始第 1 条显示旧结果 420ms", rowTexts()[0].includes("420ms"), rowTexts()[0]);
ok("初始第 2 条显示冷却中 剩", rowTexts()[1].includes("剩"), rowTexts()[1]);
ok("初始第 3 条显示 ○ 待命", rowTexts()[2].includes("○ 待命"), rowTexts()[2]);

// 点击「⚡ 测试当前链路」
const testBtn = findAll(getTree(), (n) => n.type === "button" && textOf(n).includes("测试当前链路"))[0];
ok("找到「⚡ 测试当前链路」按钮", Boolean(testBtn));

const runPromise = testBtn.props.onClick();
await new Promise((r) => setTimeout(r, 0));

const afterClickTexts = rowTexts();
ok("点击后第 1 条立刻变为「⏳ 待检查」（不再显示旧 420ms）", afterClickTexts[0].includes("⏳ 待检查") && !afterClickTexts[0].includes("420ms"), afterClickTexts[0]);
ok("点击后第 2 条立刻变为「⏳ 待检查」（覆盖旧冷却显示）", afterClickTexts[1].includes("⏳ 待检查") && !afterClickTexts[1].includes("剩"), afterClickTexts[1]);
ok("点击后第 3 条立刻变为「⏳ 待检查」（不再显示 ○ 待命）", afterClickTexts[2].includes("⏳ 待检查") && !afterClickTexts[2].includes("○ 待命"), afterClickTexts[2]);

const busyBtn = findAll(getTree(), (n) => n.type === "button" && textOf(n).includes("自检中"))[0];
ok("点击后测试按钮禁用且展示进度自检中 (0/3)", Boolean(busyBtn && busyBtn.props.disabled && textOf(busyBtn).includes("0/3")), textOf(busyBtn));

// 模拟第 1 条最先检查完成
pendingDeferred.get("p1/m1")({ ok: true, key: "p1/m1", status: "ok", latency: 185 });
await new Promise((r) => setTimeout(r, 0));
const mid1 = rowTexts();
ok("第 1 条检查完毕立即出现新结果 185ms", mid1[0].includes("185ms") && !mid1[0].includes("待检查"), mid1[0]);
ok("此时第 2、3 条仍处于「⏳ 待检查」", mid1[1].includes("⏳ 待检查") && mid1[2].includes("⏳ 待检查"), JSON.stringify(mid1));

// 模拟第 2 条（原冷却条目）检查完成
pendingDeferred.get("p2/m2")({ ok: true, key: "p2/m2", status: "ok", latency: 290 });
await new Promise((r) => setTimeout(r, 0));
const mid2 = rowTexts();
ok("第 2 条检查完毕立即出现结果 290ms（不被旧冷却遮挡）", mid2[1].includes("290ms") && !mid2[1].includes("待检查"), mid2[1]);
ok("此时第 3 条仍处于「⏳ 待检查」", mid2[2].includes("⏳ 待检查"), mid2[2]);

// 模拟第 3 条检查失败
pendingDeferred.get("p3/m3")({ ok: true, key: "p3/m3", status: "fail", error: "HTTP 502" });
await runPromise;
await new Promise((r) => setTimeout(r, 0));

const finalTexts = rowTexts();
ok("第 3 条检查失败立即出现「● 失败」", finalTexts[2].includes("失败") && !finalTexts[2].includes("待检查"), finalTexts[2]);
const restoredBtn = findAll(getTree(), (n) => n.type === "button" && textOf(n).includes("测试当前链路"))[0];
ok("全部完毕后按钮恢复为「⚡ 测试当前链路」", Boolean(restoredBtn && !restoredBtn.props.disabled), textOf(restoredBtn));
ok("全部完毕后渲染汇总文案 2 可用 / 1 不可用", textOf(getTree()).includes("2 可用") && textOf(getTree()).includes("1 不可用"));
ok("全部完毕后自动持久化探针结果", savedProbeCalls.length === 1 && savedProbeCalls[0].results["p1/m1"]?.latency === 185 && savedProbeCalls[0].results["p3/m3"]?.status === "fail");

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
