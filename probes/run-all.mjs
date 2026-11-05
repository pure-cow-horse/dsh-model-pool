/**
 * 跑全部回归探针（2026-11-05）。
 *
 * 在此之前 20 个脚本没有任何统一入口，只能手敲 `for f in probes/*.mjs`，
 * 而且那个循环在 Windows 的 npm script 里跑不起来（用的是 cmd/sh 而非 bash）。
 * 这个 runner 只做三件事：按文件名顺序跑 `verify-*.mjs`、汇总通过数、
 * 失败时把该脚本里的 `✗` 行摘出来（不必翻完整输出）。
 *
 * 用 `npm run probe` 调用；退出码 0 = 全绿，1 = 有失败。
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// run-all 自己不以 verify- 开头，不会被自己收进列表
const files = readdirSync(here)
  .filter((f) => f.startsWith("verify-") && f.endsWith(".mjs"))
  .sort();

let pass = 0;
const failed = [];

for (const file of files) {
  const result = spawnSync(process.execPath, [join(here, file)], { encoding: "utf8" });
  if (result.status === 0) {
    pass += 1;
    console.log(`PASS  ${file}`);
    continue;
  }
  failed.push(file);
  console.log(`FAIL  ${file}`);
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  for (const line of out.split(/\r?\n/).filter((l) => l.includes("✗")).slice(0, 5)) {
    console.log(`        ${line.trim()}`);
  }
  if (!out.includes("✗")) {
    // 脚本本身崩了（import 失败、语法错），没有断言输出，给出尾部几行
    for (const line of out.trim().split(/\r?\n/).slice(-4)) console.log(`        ${line}`);
  }
}

console.log(`\n${pass} 通过 / ${failed.length} 失败`);
if (failed.length > 0) {
  console.log(`失败：${failed.join(", ")}`);
  process.exit(1);
}
