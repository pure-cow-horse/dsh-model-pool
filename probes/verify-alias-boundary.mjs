/**
 * 别名边界回归（2026-11-05）。
 *
 * 背景：`dsh-our-free-model` 把 Qoder 的上游内部 key（`qmodel_38max`、`dfmodel`…）
 * 直接注册成模型 id，模型池面板原本裸露这些代号。修法是在 `/models` 返回前给
 * 已知代号补一个可读的 `modelName`（`CODE_ALIAS`）——**只改显示字段**，
 * `modelId` / `key` 必须保持原样。
 *
 * 为什么只锁这一个边界：映射表本身抄错只是显示成错字，不影响任何请求；
 * 但一旦别名蔓延到 `modelId` 或 `key`，链里存的就是可读名，上游不认，
 * 所有走这条链的对话直接失效，而且只有真正发消息才会暴露。
 * 这是整套改动里唯一会造成故障的边界，所以为它单独留一条断言。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(join(REPO, "dist", "index.js"), "utf8");

let pass = 0;
let fail = 0;
const ok = (name, condition) => {
  if (condition) {
    pass += 1;
    console.log(`✓ ${name}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}`);
  }
};

console.log("别名边界 · 显示层不得侵入路由层");

// 前置：别名表还在。它被删掉时后面的断言会"空过"，这条让失败原因指向正确的地方。
ok("别名表 CODE_ALIAS 存在", /const CODE_ALIAS = \{/.test(src));

ok("别名只写 modelName", /r\.modelName = alias;/.test(src));
ok("别名不覆盖 modelId", !/r\.modelId = alias/.test(src));
ok("别名不覆盖 key", !/r\.key = alias/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
