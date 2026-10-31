/**
 * 供应商组头的「测全部」按钮（2026-10-31）。
 *
 * 「测试全部」是把 330 个模型一起打，慢、易撞限流；排障时通常只怀疑一个渠道。
 * 组头给一个按供应商收敛的入口，点一下就把该渠道的全部模型测一遍。
 *
 * ## 钉住的要点
 *
 * 1. 目标是**该渠道的全量模型**，不受当前搜索/筛选影响 —— 按钮语义就是"全部"；
 * 2. 未注册的模型跳过，不产生注定失败的记录；
 * 3. 组头整行点击是"折叠/展开"，按钮必须 stopPropagation，否则一点就把组收起来；
 * 4. 进度实时可见（测中 3/7），结束写 saveProbe 持久化；
 * 5. 失败也落 results，与行内「测」共用展示 —— 不能静默吞掉。
 *
 * 用法：node probes/verify-provider-test-button.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const src = readFileSync(join(REPO, "dist", "client.js"), "utf8");

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

console.log("供应商组头 · 测全部");

ok("有批量测试函数", /const testProvider = async \(provider\) =>/.test(src));
ok("取该供应商全量模型", /m\.provider === provider && m\.registered !== false/.test(src));
ok("跳过未注册模型", src.includes("m.provider === provider && m.registered !== false"));
ok("并发 4", /const conc = 4;/.test(src));
ok("有进度状态", /const \[providerTesting, setProviderTesting\] = useState\(\{\}\)/.test(src));
ok("进度文案 测中 n/m", /测中 \$\{providerTesting\[provider\]\.done\}\/\$\{providerTesting\[provider\]\.total\}/.test(src));
ok("在途禁用按钮", /disabled: providerTesting\[provider\] !== void 0/.test(src));
ok("按钮阻断组头折叠", /onClick: \(e\) => \{ e\.stopPropagation\(\); void testProvider\(provider\); \}/.test(src));
ok("失败落 results", /catch \(error\) \{\s*next = \{ status: "fail", error/.test(src));
ok("结束持久化 saveProbe", /const testProvider[\s\S]{0,1600}?saveProbe\(out, ts\);/.test(src));
ok("结束后清理进度", /delete next\[provider\];/.test(src));
ok("组头按钮放在「拉上游」之前", src.indexOf("测全部 ${rows.length}") < src.indexOf("拉取该供应商上游"));
ok("不影响原有「拉上游/禁用」", /拉取该供应商上游/.test(src) && /从 DSH 的模型选择列表里隐藏该供应商/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
