/**
 * 多模态（图片输入）智能避障与失败诊断元数据回归校验。
 *
 * 验证：
 *   1. requestHasImages 准确识别 messages 中的 image/image_url/attachments 图片块。
 *   2. 当请求含图片时，自动跳过链上不支持视觉的纯文本模型（skipped=true），且绝对不写入冷却。
 *   3. 自动将请求无缝移交给后续具备视觉能力的多模态模型并成功产出。
 *   4. 后续纯文本请求不受影响，第一顺位纯文本模型依旧正常优先接客。
 *   5. 失败或跳过的 attempt 完整记录 rawError, status, code, durationMs 供诊断弹窗读取。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const tempHome = mkdtempSync(join(tmpdir(), "pool-probe-vision-"));
const savedUserProfile = process.env.USERPROFILE;
const savedHome = process.env.HOME;
const savedDshHome = process.env.DSH_HOME;
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.DSH_HOME = tempHome;

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
const { __PoolAdapter } = mod;

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

console.log("model-pool 多模态避障与失败诊断测试");

// 1. 多模态请求智能避障
{
  const calls = [];
  const fakeLlm = {
    async resolveModelInfo(provider, model) {
      if (model.includes("vision") || model.includes("qwen-vl") || model.includes("max")) {
        return { inputModalities: ["text", "image"] };
      }
      return { inputModalities: ["text"] };
    },
    stream(opts) {
      calls.push(`${opts.provider}/${opts.model}`);
      return (async function* () {
        yield { type: "text-delta", text: "这是视觉回答" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };

  const state = {
    activeScheme: "test",
    schemes: {
      test: {
        chain: ["deepseek/deepseek-chat", "qwen/qwen-vl-max"],
      },
    },
  };

  const adapter = new __PoolAdapter(() => state, () => fakeLlm);

  // 发起带图片的请求
  const imageRequest = {
    model: "test",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ],
  };

  const chunks = [];
  for await (const chunk of adapter.stream(imageRequest)) {
    chunks.push(chunk);
  }

  ok("流式正常产出内容", chunks.some((c) => c.text === "这是视觉回答"));
  ok("纯文本模型未被实际调用", !calls.includes("deepseek/deepseek-chat"));
  ok("自动跳过并命中了多模态模型 qwen/qwen-vl-max", calls.includes("qwen/qwen-vl-max"));

  const dsAttempt = adapter.attempts.find((a) => a.entry === "deepseek/deepseek-chat");
  ok("纯文本模型 attempt 被标记为 skipped", dsAttempt?.skipped === true);
  ok("纯文本模型包含避障原因", dsAttempt?.error?.includes("多模态避障跳过"));
  ok("包含详细 rawError 诊断信息", dsAttempt?.rawError?.includes("仅支持纯文本输入"));
  ok("避障跳过绝对不写入冷却", !adapter.cooldown.has("deepseek/deepseek-chat"));

  // 随后发起纯文本请求
  calls.length = 0;
  const textRequest = {
    model: "test",
    messages: [{ role: "user", content: "纯文本提问" }],
  };
  const textChunks = [];
  for await (const chunk of adapter.stream(textRequest)) {
    textChunks.push(chunk);
  }

  ok("纯文本请求优先命中第一顺位 deepseek-chat", calls[0] === "deepseek/deepseek-chat");
  ok("第一顺位未受上轮图片避障的任何冷却惩罚", !adapter.cooldown.has("deepseek/deepseek-chat"));
}

// 2. 失败诊断详情字段完整性
{
  const fakeFailLlm = {
    stream() {
      const err = new Error("Connection refused to upstream gateway");
      err.code = "ECONNREFUSED";
      err.status = 502;
      throw err;
    },
  };

  const state = {
    activeScheme: "t",
    schemes: { t: { chain: ["fail-provider/m1"] } },
  };

  const adapter = new __PoolAdapter(() => state, () => fakeFailLlm);
  try {
    for await (const _ of adapter.stream({ model: "t", messages: [] })) {}
  } catch {}

  const att = adapter.attempts[0];
  ok("失败 attempt 包含 error 摘要", typeof att.error === "string" && att.error.includes("Connection refused"));
  ok("失败 attempt 包含 rawError 完整堆栈", typeof att.rawError === "string" && att.rawError.includes("Error: Connection refused"));
  ok("失败 attempt 记录了错误代码 code=ECONNREFUSED", att.code === "ECONNREFUSED");
  ok("失败 attempt 记录了 HTTP 状态码 status=502", att.status === 502);
  ok("失败 attempt 记录了耗时 durationMs", typeof att.durationMs === "number" && att.durationMs >= 0);
}

if (savedUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = savedUserProfile;
if (savedHome === undefined) delete process.env.HOME;
else process.env.HOME = savedHome;
if (savedDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = savedDshHome;
rmSync(tempHome, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
