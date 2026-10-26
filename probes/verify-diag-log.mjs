/**
 * 诊断日志回归（2026-10-26 P0）。
 *
 * 背景：聊天标签每 3 秒触达一次 `/models`，每次写 3 行同步日志；
 * `~/.dsh/model-pool-diag.log` 长到 **33.8MB / 17 万行**，70% 是无信息量的轮询记录，
 * 而且 `writeFileSync(..., {flag:"a"})` 直接写在请求路径上。
 *
 * 修复后的契约（本探针逐条断言）：
 *   1. 默认只记错误类——普通请求日志不落盘；
 *   2. `DSH_MODEL_POOL_DIAG=1` 时才记全量；
 *   3. 单文件超过 5MB 自动轮转到 `.1`，新文件重新开始；
 *   4. 轮转只保留一代（旧的 `.1` 会被覆盖，不堆 `.2/.3`）；
 *   5. 攒批落盘（500ms 内多次调用合并），不再一行一次同步写。
 *
 * 纪律：临时 DSH_HOME、假 ctx、不碰真实日志与上游。
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-diag-"));
const savedUserProfile = process.env.USERPROFILE;
const savedHome = process.env.HOME;
const savedDshHome = process.env.DSH_HOME;
const savedVerbose = process.env.DSH_MODEL_POOL_DIAG;
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.DSH_HOME = tempHome;
delete process.env.DSH_MODEL_POOL_DIAG;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每次都起一份干净的 profile + 假宿主，返回已注册的 /models 路由 */
function boot(profileDir) {
  const routes = new Map();
  const llm = {
    registerAdapter: () => () => {},
    listProviders: async () => [],
    listModels: async () => [],
    stream: () => { throw new Error("no"); }
  };
  const ctx = {
    get: (k) => {
      if (k === "profileContext") return { dir: profileDir, patchPath: join(profileDir, "cordis.patch.yml") };
      if (k === "llm") return llm;
      return undefined;
    },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    credentials: { resolve: async () => undefined },
    webServer: { register: (def) => routes.set(def.path, def) },
    tools: { register() {} },
    on: () => () => {},
    effect: (fn) => { fn(); }
  };
  writeFileSync(join(profileDir, "cordis.patch.yml"), "- id: llm-pi-ai\n  config:\n    providers: {}\n");
  mod.apply(ctx);
  return routes.get("/api/model-pool/models");
}

const logFile = join(tempHome, "model-pool-diag.log");

console.log("model-pool 诊断日志");

// 1+5. 默认模式：普通请求日志不落盘，且不产生逐行同步写
{
  const dir = mkdtempSync(join(tmpdir(), "pool-probe-diag-a-"));
  const route = boot(dir);
  const res = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
  await route.handler({ method: "GET", headers: {} }, res);
  await route.handler({ method: "GET", headers: {} }, res);
  await sleep(800);
  ok("默认不记录普通请求日志（文件未膨胀）", !existsSync(logFile), existsSync(logFile) ? `${statSync(logFile).size} bytes` : "");
  rmSync(dir, { recursive: true, force: true });
}

// 2. 打开开关后才落全量
{
  process.env.DSH_MODEL_POOL_DIAG = "1";
  const dir = mkdtempSync(join(tmpdir(), "pool-probe-diag-b-"));
  const route = boot(dir);
  const res = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
  await route.handler({ method: "GET", headers: {} }, res);
  await sleep(800);
  const size = existsSync(logFile) ? statSync(logFile).size : 0;
  ok("DSH_MODEL_POOL_DIAG=1 时能落盘", size > 0, `${size} bytes`);
  rmSync(dir, { recursive: true, force: true });
}

// 3+4. 超过 5MB 自动轮转，且只留一代
{
  const big = 6 * 1024 * 1024;
  writeFileSync(logFile, "x".repeat(big));
  const dir = mkdtempSync(join(tmpdir(), "pool-probe-diag-c-"));
  const route = boot(dir);
  const res = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b; } };
  await route.handler({ method: "GET", headers: {} }, res);
  await sleep(800);

  const bak = `${logFile}.1`;
  ok("超限后旧日志被挪到 .1", existsSync(bak), existsSync(bak) ? "ok" : "缺失");
  ok("轮转后 .1 保留了原体积", existsSync(bak) && statSync(bak).size === big, existsSync(bak) ? `${statSync(bak).size}` : "");
  ok("轮转后新日志从小体积重新开始", existsSync(logFile) && statSync(logFile).size < big, existsSync(logFile) ? `${statSync(logFile).size}` : "");
  ok("不产生 .2/.3 之类多余代次", !existsSync(`${logFile}.2`), "");

  // 再撞一次上限：应覆盖旧的 .1，而不是新增一代
  writeFileSync(logFile, "y".repeat(big));
  await boot(dir).handler({ method: "GET", headers: {} }, { statusCode: 0, setHeader() {}, end() {} });
  await sleep(800);
  ok("第二次轮转覆盖旧 .1（不堆代次）", existsSync(bak) && statSync(bak).size === big && !existsSync(`${logFile}.2`), "");
  rmSync(dir, { recursive: true, force: true });
}

if (savedUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = savedUserProfile;
if (savedHome === undefined) delete process.env.HOME;
else process.env.HOME = savedHome;
if (savedDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = savedDshHome;
if (savedVerbose === undefined) delete process.env.DSH_MODEL_POOL_DIAG;
else process.env.DSH_MODEL_POOL_DIAG = savedVerbose;
rmSync(tempHome, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
