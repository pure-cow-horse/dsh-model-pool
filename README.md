# dsh-model-pool

DeepSeek Harness（DSH）插件：在一个面板里探测各供应商可用模型并做最小请求有效性测试，勾选模型组建多个自定义方案（纯 deepseek / 纯 glm / 纯 gemini…），由插件自带的故障转移引擎按链顺序顺延接管。

## 功能

### 模型列表（探测与测试）
- 合并三类模型来源：
  - 静态配置 `llm-pi-ai.providers` 中已配置的模型；
  - 运行时经 `registerAdapter` 动态注册的渠道（如 Qoder / Trae 等对接插件）；
  - WorkBuddy / WorkBuddy AI 本地 catalog 缓存。
- 同供应商分组折叠，支持全部折叠 / 全部展开。
- 筛选：全部 / 仅可用 / 按供应商 / 按模型族；列表限屏渲染，避免上千行卡死。
- 单模型「测」或「测试全部」：发最小请求（短超时、并发限制），标记可用 / 不可用并记录延迟与错误摘要。

### 方案与链路
- 可建多个命名方案，例如「纯 deepseek」「纯 glm」「纯 gemini」。
- **+ 勾选加入当前方案**：把勾选模型去重追加到链末尾，不覆盖原有顺序。
- **由勾选内容新建方案**：用勾选集合另存为新方案。
- 内置排序（整体替换当前链）：同档聚类、延迟优先、免费优先。
- 链上项目支持拖拽排序、单项移除、切换激活方案。
- **测试当前链路**：只测当前激活方案链上的模型（不碰整张清单），按链顺序返回可用/不可用/跳过与延迟，链上每条后面直接显示状态点和耗时。配置渠道直连探测，运行时注册的渠道（qoder / trae / workbuddy4）经宿主运行时探测——后者没有 baseURL + Key 可直连，走 `llm.stream` 才是准的。

### 故障转移引擎（虚拟 provider：ModelPool）
- 模型选择器中每个方案显示为一个可选虚拟模型；`Auto` 跟随面板当前激活方案。
- 发起级顺延：按链顺序尝试，某条在发起连接时失败（鉴权 / 额度 / 限流 / 服务端错误 / 超时 / 传输错误 / 空响应）即进入冷却并跳到下一条，到期自动恢复；全部失败则抛出最后一个错误。冷却时长在面板「失败冷却（秒）」里可调，默认 60 秒，范围 5～3600。
- 对话输入框的模型按钮，闭合时直接显示实际命中的 `供应商/模型`，展开下拉时恢复方案名。

## 安装（本地 file: 方式）

1. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加入：
   ```json
   "dsh-model-pool": "file:<插件目录绝对路径>"
   ```
2. 在同一文件的 `dsh.profile.bundles` 列表加入 `"dsh-model-pool"`。
3. 执行 `pnpm install` 后重启 DSH。

> 若曾使用旧的 `dsh-llm-fallbacks`，建议从 bundles 移除或在插件页关闭，避免两套顺延引擎同时生效。

## 数据
- 方案、激活方案与链路保存在 `<profile.dir>/model-pool.json`，不改动 `llm-pi-ai` 配置。
- 测试结果（状态/延迟/错误）持久化到 `<profile.dir>/model-pool-probe.json`，刷新后仍在，不存上游凭证。
- 诊断日志在 `~/.dsh/model-pool-diag.log`：**默认只记错误**，要看全量请求轨迹需设 `DSH_MODEL_POOL_DIAG=1`；
  单文件超过 5MB 自动轮转到 `model-pool-diag.log.1`（只留一代）。

## 目录
```
dsh-model-pool/
  package.json
  cordis.patch.yml
  dist/index.js    # host：配置读取、模型合并、最小测试、HTTP 路由、虚拟顺延引擎
  dist/client.js   # client：模型列表 / 方案链路面板、对话模型标签
  README.md
  LICENSE
```

## 边界与局限（第一版）
- 发起级顺延：仅在发起同步失败时切换；流已正常产出后的中途断开不会切下一条（内容已交给宿主，切了会重复），但**会记录真实原因并冷却该渠道**，下一轮自动跳过。
- 冷却时长可配：面板「失败冷却（秒）」，默认 60，范围 5～3600；存于 `model-pool.json` 的 `cooldownMs`。
- 动态回环对接渠道（Qoder / Trae 等）在列表中展示，第一版不对其发最小请求测试。
- 不做供应商登录/签到、用量看板、外发 OpenAI 端点、时段链或角色链。

## 回归探针
```bash
node probes/verify-tool-call-output.mjs                              # 测本仓库 dist/index.js
POOL_PROBE_TARGET=installed node probes/verify-tool-call-output.mjs  # 测 profile 里跑着的那份
node probes/verify-unsupported-effort-skip.mjs                       # 同上双目标，加 POOL_PROBE_TARGET=installed
node probes/verify-error-reporting.mjs                               # 失败原因 + 冷却配置，同上双目标
node probes/verify-test-chain.mjs                                    # 链路自检路由，同上双目标
node probes/verify-diag-log.mjs                                      # 诊断日志开关与轮转，同上双目标
```
五个探针共 52 项断言：
- **verify-tool-call-output**（8）：正文文本算产出；**纯工具调用回合算产出**（`tool-call-delta` / `block-end(type=tool-call|tool-result)`）；
  只有 `reasoning-delta` 仍判空流；全空流与无产出的错误 finish 文案不变；产出块原样透传。
- **verify-unsupported-effort-skip**（6）：渠道明确拒绝过的 reasoning 档位记 10 分钟，期间直接走默认档
  （方案固定 effort=medium 而目录只有 high/max/low 时，旧行为每回合白跑一趟——2026-10-24 实测 270 次/天）；
  TTL 过期自愈，档位被接受时清记忆。
- **verify-error-reporting**（17）：中途断流记 midStream + 真实原因并写冷却；空 failure 有兜底文案，
  `error` 不再可能为 null；冷却默认 60 秒、可配、5 秒～1 小时 clamp；POST 能持久化、GET 能读回。
- **verify-test-chain**（14）：链路自检只测链上条目且保持顺序；配置渠道走直连、运行时渠道走
  `llm.stream`；运行时错误块判 fail 且原因带 code；GET 405、跨域 403、空链不报错。
- **verify-diag-log**（7）：默认只记错误类、`DSH_MODEL_POOL_DIAG=1` 才记全量；超 5MB 轮转到 `.1`
  且只留一代；攒批落盘。

> 2026-10-24 修复记录：旧判定只认正文文本，**只发起工具调用、不带开场白**的合法 agent 回合
> 被判「返回空流（无可见正文）」并冷却渠道 1 分钟（当天全日志 728 次，qoder-cn 63 次、
> workbuddy4 121 次、trae 33 次），用户侧表现是"渠道用不了、已顺延"。

> 2026-10-25 修复记录：`/api/model-pool/current` 里出现 `{ ok: false, error: null }` 的哑失败。
> 根因是 `_attemptStream` 的**中途断流**分支——已有产出后再收到 error finish 时直接
> `yield chunk; return`，既不写 `attempt.error` 也不写冷却（本该负责这事的 `_wrap` 从未被调用，
> 已删除）。现在该分支会记 `midStream: true` + 真实原因（code / HTTP 状态 / message）并冷却；
> `failure` 为空时也有兜底文案，`error` 不再可能为 null。冷却时长同时改为可配（默认 60 秒），
> 面板会显示「本次失败/跳过的渠道」与「冷却中」列表。

## 协议
MIT
