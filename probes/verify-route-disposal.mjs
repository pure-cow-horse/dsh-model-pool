/**
 * 路由要能被注销，否则软重启会把旧 handler 留在表里（2026-10-31）。
 *
 * ## 事故
 *
 * 用 dsh-unlag 软重启后，`/api/model-pool/usage` 仍返回旧结构。查下来是模型池的
 * `reg()` 把 `webServer.register()` 返回的 **disposer 丢了**，而且撞 `duplicate`
 * 时静默跳过 —— 于是旧实例的路由一直占着，新实例注册不进去，代码改了等于没改。
 *
 * ## 修法
 *
 * 1. 收好每一条 disposer，在 `ctx.effect` 的清理函数里逆序释放；
 * 2. 撞车不再静默：记进 `routeConflicts` 并写诊断日志，`/current` 也带出来。
 *
 * ## 探针钉住
 *
 * 这条逻辑活在插件生命周期里，单元测试够不到，所以只做静态核查 —— 但核查的是
 * "有没有真的接住返回值"这种漏了就白改的点。
 *
 * 用法：node probes/verify-route-disposal.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const src = readFileSync(join(REPO, "dist", "index.js"), "utf8");

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
	if (cond) {
		pass += 1;
		console.log(`  \u2713 ${name}`);
	} else {
		fail += 1;
		console.log(`  \u2717 ${name}${detail === undefined ? "" : `\n      ${detail}`}`);
	}
};

console.log("路由注销（软重启能真正换代码）");

ok("声明了 disposer 容器", /const routeDisposers = \[\];/.test(src));
ok("接住了 register 的返回值", /const dispose = ctx\.webServer\.register\(opts\);/.test(src));
ok("disposer 入栈", /routeDisposers\.push\(dispose\)/.test(src));
ok("在 ctx.effect 清理里释放", /ctx\.effect\(\(\) => \(\) => \{[\s\S]{0,400}?routeDisposers\[index\]\(\)/.test(src));
ok("释放后清空容器", /routeDisposers\.length = 0;/.test(src));
ok("逆序释放", /for \(let index = routeDisposers\.length - 1; index >= 0; index -= 1\)/.test(src));

// 撞车不能再静默
const dupBlock = /if \(!\/duplicate\/i\.test[\s\S]{0,320}?routeConflicts\.push\(opts\.path\)/.exec(src);
ok("duplicate 不再静默（记进 routeConflicts）", dupBlock !== null);
ok("duplicate 有诊断日志", /route dup \$\{opts\.path\}/.test(src));
ok("冲突暴露到 /current", /routeConflicts \}\);/.test(src));

// 确认没有回退成"丢掉返回值"的老写法
const oldStyle = /try \{ ctx\.webServer\.register\(opts\); diag/.test(src);
ok("没有残留「丢返回值」的旧写法", oldStyle === false);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
