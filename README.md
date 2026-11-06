# dsh-model-pool

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/pure-cow-horse/dsh-model-pool?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/pure-cow-horse/dsh-model-pool/stargazers"><img src="https://img.shields.io/github/stars/pure-cow-horse/dsh-model-pool?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/pure-cow-horse/dsh-model-pool/commits/main"><img src="https://img.shields.io/github/last-commit/pure-cow-horse/dsh-model-pool?style=flat-square" alt="last commit"></a>
</p>

[English](./README.en.md) | 中文

把手上一堆能白嫖 / 能试用的模型，变成一个**会自动换人**的模型池。

DSH 里配了七八家供应商之后，日常的麻烦不是「没有模型」，而是：这家今天限流了、那家额度用完了、某个免费渠道悄悄下线了、这个模型不支持图片而我刚贴了张图。这个插件把这些判断收进一个面板，并把「换人」这件事交给一个虚拟 provider 在请求发起时自动完成 —— 你只需要选方案，不用选具体哪家。

它做三件事：

| 你在面板里做的事 | 它在背后做的事 |
| --- | --- |
| 看清**哪家有哪个模型、通不通** | 合并三类来源，探测与最小请求测试，一键拉上游全量目录 |
| 决定**按什么顺序用** | 多命名方案 + 有序链，拖拽排序，内置三种排序策略 |
| 出事时**自动往下试** | 虚拟 provider `ModelPool`，发起级顺延 + 冷却 + 指数退避 + 多模态避障 |

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile desktop add github:pure-cow-horse/dsh-model-pool
```

装完重启 DSH。桌面版用 `--profile desktop`，Web 版换成 `--profile web`。

<details>
<summary>其它安装方式</summary>

从本地目录安装（改代码即生效，适合开发）：

```sh
dsh plugin --profile desktop add file:C:/path/to/dsh-model-pool
```

或直接编辑 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "dsh-model-pool": "file:<插件目录绝对路径>" },
  "dsh": { "profile": { "bundles": ["dsh-model-pool"] } }
}
```

改完 `pnpm install` 再重启。

</details>

### 前置条件

- 已在 DSH 里配置至少一个模型供应商（`llm-pi-ai.providers`），或装了对接插件（WorkBuddy / Qoder / Trae 等）让它运行时注册渠道。
- 官方 `@deepseek-ai/*` 包在 `peerDependencies` 里，由宿主提供，不需要也不能单独安装。

> **和 `dsh-llm-fallbacks` / `JiahaoXxX/dsh-model-pool` 的关系：** 本插件**不是**它们的 fork，代码与数据格式都是独立的（状态文件是 `model-pool.json`，profile 行 id 是 `dsh-model-pool`，都不会与 `llm-fallbacks` 撞车）。但两者都实现「降级链」，同时启用会切两次、浪费一次往返，建议只留一个。

## 界面

面板有三个入口，指向同一个组件：左侧导航「模型池」、设置页「模型池」、主区 `model-pool` 面板。

三个页签：

| 页签 | 干什么 |
| --- | --- |
| **模型列表** | 看有哪些模型、批量测试、拉上游、接入配置、启停供应商 |
| **方案与链路** | 组方案、排顺序、测链路、调档位与冷却 |
| **用量统计** | 按日 × 来源 × 渠道 × 模型 记 token，导出 CSV |

### 模型列表

**来源合并。** 面板里的模型来自三处，按 provider 去重后并集：

1. `llm-pi-ai.providers` 里静态配置的模型；
2. 运行时经 `registerAdapter` 动态注册的渠道（Qoder、Trae、WorkBuddy 这类对接插件）；
3. 本地 catalog 缓存扫描 —— `.workbuddy-catalog.json`、`.workbuddy-ai-catalog.json`、`.workbuddy<N>-catalog.json`、`.qoder-catalog.qoder-cn.json`、`.qoder-catalog.qoder.json`。

**看的效率。** 供应商分组折叠，支持全部折叠 / 全部展开；每组默认只列前 20 个（上千行会卡），超出给「展开剩余 N 个」；搜索或筛选时自动展开全部，不会出现「搜到了却看不见」。表头点一下就出筛选面板（供应商 / 族 / 免费 / 状态），列与列之间是**组合**关系，同一列内可升降序。计数会**忽略本列自己的条件** —— 否则选中「免费=是」之后其余选项全变 0，看起来像数据丢了。

**测。** 单行「测」或供应商组头「测试全部」，发一个最小请求，标记可用 / 不可用并记延迟与错误摘要。配置型渠道直连探测（`GET {baseURL}/models` + 最小 chat），运行时渠道走宿主 `llm.stream` —— 后者没有 baseURL + Key 可直连，走宿主才是准的。走的时候按钮变「测中…」并禁用，失败也落结果，不会静默吞掉。测试结果持久化，刷新后仍在。

**拉上游。** 供应商组头上的「拉上游」调该渠道的 `GET {baseURL}/models`，把**上游全量目录**（含还没写进配置的模型）拉回面板；目录自带搜索框，各供应商一份关键词互不干扰；「全选 / 反选」只作用于**当前搜索结果**，并与既有勾选合并 —— 搜完点全选不会把别的模型取消掉。

**接入 / 禁用。** 「接入选中 N 个」把勾选结果写回 `llm-pi-ai.providers.<供应商>.models`，语义是**整体替换**（没勾的会从 DSH 移除），写前自动备份 patch、按 revision 重试冲突、写后回读校验、不一致必须报错。分组头「禁用」把该渠道从 `llm-pi-ai.providers` 摘出来（完整定义暂存到 `model-pool.json` 的 `disabledProviders`），宿主随即不再注册它，**对话的模型选择列表里就看不到了**；面板顶部「已禁用」条里点「启用」原样写回。不丢 key / baseURL / 模型清单。（宿主没有「按供应商禁用」的字段，只能这么做；禁用正在链上使用的渠道会提示受影响条目数。）

**别名。** Qoder 会把上游内部代号（`qmodel_38max`、`dfmodel`、`gmodel`…）直接当模型 id 注册，面板原本裸露这些代号。插件在 `/models` 返回前给已知代号补一个可读 `modelName`，**只改显示字段** —— `modelId` 与 `key` 保持原样，否则链里存的就是可读名、上游不认、整条链失效。国内版与国际版有两处同名不同代（`mmodel` 国内是 MiniMax-M2.7、国际是 M3），单独按 provider 覆盖。

### 方案与链路

- 可建多个命名方案（「纯 deepseek」「纯 glm」「代码主力」…），激活其中一个。
- **+ 勾选加入当前方案**：勾选模型去重后追加到链末尾，不覆盖原有顺序。
- **由勾选内容新建方案**：用勾选集合另存为新方案。
- **三种内置排序**（整体替换当前链）：同档聚类（按模型族归并）、延迟优先（按上次实测延迟）、免费优先。
- 链上条目支持拖拽排序、单项移除、切换激活方案。
- **测试当前链路**：只测激活方案链上的模型（不碰整张清单），按链顺序返回可用 / 不可用 / 跳过与延迟，链上每条后面直接显示状态点与耗时。并发默认 4，可传 1–8。
- 行内「测」：某条在自检里可能既没绿点也没红点，不知道它通不通。行内单独打一次，结果与「自检」共用同一张 results 表，两处不会各说各话。
- **上下文窗口**：面板里填 `128k` / `1m` 这类值，作为**全局覆盖**交给宿主（不填则用模型自己的默认值）。
- **思考强度**：方案级一个下拉（全链统一，降级换供应商时强度保持一致）；对话输入框旁另有供应商级档位条，按该供应商**实际支持**的档位渲染，用户选过就按供应商分别记住。档位是 per-model 能力，不同供应商档位不同，所以不能写死一份。

### 用量统计

按 **日 × 来源 × 渠道 × 模型** 记 token。两个数据源合并：

1. **池子台账**：模型池在候选流里拦到的 `usage` 块 —— 所有走池子的对话都经过这里，且这一刻明确知道是哪个渠道的哪个模型。
2. **会话日志回放**：用户在模型列表里直接选某个具体模型时，宿主绕过池子直发，池子看不见 —— 这部分靠回放会话日志补。回放读 `request/header`（`data.header.config.provider/model`）与 assistant 事件里的 `usage`，跳过 `provider === "ModelPool"` 的请求（那些台账已经记过，不跳就是同一笔算两次），用 `turn:step` 去重（中途快照与最终消息都可能带 usage，必须覆盖而非累加），并按 `0xFD2FB528` magic 切**多帧 zstd** 逐帧解压。

记账口径：

- `attempts` 每次发起 +1；`requests` 只在**产出正文或工具调用**后 +1，`errors` 反之。一次对话换 3 个候选才有 1 个成功 → 3 attempts / 1 request / 2 errors。
- token **只在上游真回报时累加** —— 失败流通常没有 usage，不该凭空记消耗，也不补 0、不估算。
- **缓存读单列**：本项目实测缓存读能到输入的 10 倍量级，混进 input 会让「我用了多少」彻底失真。
- 按**本地时区**切天（用 UTC 的话，晚上 8 点后的用量会记到「明天」）。

页面里可切换**来源**筛选（全部 / 池子 / 直连）：概览与逐日会跟着重算，**对账那行始终全量** —— 它是数据完整性的证明，跟着筛选就失去意义。可一键导出 CSV（带 BOM，Excel 直接分列）。

## 故障转移引擎（虚拟 provider `ModelPool`）

模型选择器里，`Auto` 跟随面板当前激活方案；每个方案也各自显示为一个可选虚拟模型（虚拟模型 id 就是方案名）。

**发起级顺延。** 按链顺序尝试，某条在发起连接时失败即进入冷却并跳到下一条，到期自动恢复；全部失败则抛出最后一个错误。触发切换的失败码：`AUTH`、`QUOTA`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`。

**冷却与退避。** 基准冷却默认 60 秒，范围 5 秒 – 1 小时，面板可调（存 `cooldownMs`）。连续失败按 2 的幂退避（1x、2x、4x…），上限默认 500 秒、范围 10 秒 – 1 小时（存 `maxBackoffMs`）；调用成功后自动重置该渠道的连续失败次数。面板可一键清空冷却与退避阶梯。

**多模态避障。** 请求含图片时自动识别（`image` / `image_url` / `input_image` 块、`part.image`、`image/*` 的 mime、`options.images`），平滑跳过链上不支持视觉的纯文本模型 —— **不计失败、不入冷却**，直接把请求交给后续具备 Vision 能力的模型。后续纯文本请求不受影响，第一顺位照常优先接客。

**已被拒绝的档位记忆。** 某渠道明确回 `UNSUPPORTED_REASONING_EFFORT` 后，该档位记 10 分钟，期间直接走默认档，不再每回合白跑一趟往返；TTL 过期自愈，档位被接受时清记忆。

**诊断。** 面板「本次失败 / 跳过的渠道」列出每个 attempt 的真实上游状态码、HTTP 报错、耗时、`rawError`，点「详情」弹窗看完整报文。`/api/model-pool/current` 同时带出 `cooling`、`routeConflicts`。

**输入框标签。** 对话输入框的模型名，在选中 `ModelPool` 时改为显示实际命中的「供应商 / 模型 · 档位」，并附一个紧凑的档位切换；选中别的模型时退回显示模型名本身。这个格子在 DSH 里是 `single` 槽（同优先级二次注册会抛错、只渲染优先级最低的那条），本插件以 `priority: -2` 占位，所以**宿主自带的模型徽章与连接类插件的胶囊不会同时显示**——这是单槽位的固有取舍，不是本插件额外画的。

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `<profile.dir>/model-pool.json` | 方案、激活方案、链路、`providerEfforts`、`cooldownMs`、`maxBackoffMs`、`contextWindow`、`disabledProviders`、`probeCache`。原子写（tmp + rename） |
| `<profile.dir>/model-pool-probe.json` | 上次连通性测试的状态 / 延迟 / 错误。不存上游凭证 |
| `<profile.dir>` 或 `~/.dsh`/`model-pool-lastuse.json` | 最近一次实际命中（跨重启保留，只认 24 小时内） |
| `~/.dsh/model-pool/usage/YYYY-MM-DD.json` | token 台账，一天一个文件，原子写，保留 180 天 |
| `~/.dsh/model-pool-diag.log` | 诊断日志。**默认只记错误**，`DSH_MODEL_POOL_DIAG=1` 才记全量；超 5MB 轮转到 `.log.1`，只留一代 |
| `<profile.dir>/cordis.patch.yml.bak-modelpool-<时间戳>` | 写配置前的备份，**只保留最近 10 份** |

插件**不改动** `llm-pi-ai` 配置，唯二例外是面板里主动点「接入选中 N 个」或「禁用」—— 两者都会先备份。

## HTTP 接口

全部挂在 `/api/model-pool/` 下，13 条，仅供本机同源面板调用（跨域拒绝，写操作只收 POST）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/providers` | 供应商清单（不含密钥） |
| GET | `/models` | 拉上游全目录并合并已配置模型 |
| POST | `/upstream` | 拉指定供应商上游 `/v1/models` 全目录 |
| POST | `/apply-models` | 勾选结果整体写回 DSH 配置 |
| POST | `/toggle-provider` | 启用 / 禁用供应商 |
| GET/POST | `/chain` | 读方案与激活链 / 保存方案、切换激活 |
| GET | `/current` | 最近一次命中 + 尝试 + 冷却 + 路由冲突 |
| GET | `/efforts` | 每个候选模型实际支持的思考档位 |
| POST | `/test` | 单模型最小请求测试 |
| POST | `/test-chain` | 只测当前（或指定）方案的链路 |
| GET/POST | `/probe-results` | 读写上次测试结果 |
| POST | `/clear-cooldown` | 清空冷却与退避阶梯 |
| GET | `/usage?days=7` | 每日 × 模型的 token 台账（只读，`days` 上限 180） |

## 回归探针

逻辑大多活在插件生命周期与渲染闭包里，单元测试够不到，所以每个「改错了不会报错、只会静默出错」的点都留了一条静态 / 本地假上游探针。

```sh
node probes/run-all.mjs          # 全部跑一遍
```

**21 个探针，264 条断言，当前全绿。**

| 探针 | 断言 | 钉住的点 |
| --- | --- | --- |
| verify-alias-boundary | 4 | 别名只改 `modelName`，`modelId` / `key` 必须原样 |
| verify-cache-hygiene | 9 | 同批 5 次 `/test` 只 describe 一次；写入后缓存失效；备份超 10 份裁最旧 |
| verify-chain-row-test | 8 | 行内「测」用链路条目本身当键，结果与自检共用一张表 |
| verify-clear-cooldown | 16 | 单条 / 全量清理，不污染 `lastUse`，路由只收本地 POST |
| verify-diag-log | 7 | 默认只记错误，`DSH_MODEL_POOL_DIAG=1` 记全量，5MB 轮转只留一代 |
| verify-error-reporting | 17 | 中途断流记 `midStream` + 真实原因并冷却；`error` 不再可能为 null |
| verify-exponential-backoff | 16 | 2^n 退避、上限封顶、成功后重置、`streak` 汇报 |
| verify-model-header-filter | 24 | 表头筛选计数忽略本列；筛选用与显示同一套判据；无第二套入口 |
| verify-model-list-ux | 13 | `th` 吸顶；点「测」先置在途态，失败也写结果 |
| verify-multimodal-guard | 14 | 图片请求跳过无视觉模型且不写冷却；后续纯文本不受影响 |
| verify-provider-test-button | 13 | 「测全部」打该渠道全量模型、跳过未注册、`stopPropagation` |
| verify-provider-toggle | 15 | 禁用后配置里没有它、完整定义可无损恢复、`/models` 立刻反映 |
| verify-route-disposal | 10 | 每条路由的 disposer 都被接住并在 `ctx.effect` 里逆序释放 |
| verify-session-replay | 13 | 跳过 `ModelPool`、`turn:step` 去重、多帧 zstd 逐帧解压 |
| verify-single-test | 12 | 运行时渠道不再 404；状态文件按 mtime 失效 |
| verify-test-chain | 14 | 只测链上条目且保序；配置渠道直连、运行时渠道走宿主 |
| verify-tool-call-output | 8 | 纯工具调用回合算产出，只有 `reasoning-delta` 仍判空流 |
| verify-unsupported-effort-skip | 6 | 被拒档位记 10 分钟，TTL 过期自愈 |
| verify-upstream-apply | 13 | 拉目录、整体替换、不抹掉原有字段、写前备份、回读不一致必报错 |
| verify-usage-ledger | 18 | 失败不补 token、缓存读单列、本地时区切天、180 天只删自己写的 |
| verify-usage-source-filter | 12 | 筛选后概览与逐日跟着重算，对账行始终全量 |

所有探针都支持 `POOL_PROBE_TARGET=installed` 改为测 profile 里正在跑的那份（默认测本仓库 `dist/`）。

## 边界与局限

- **发起级顺延**：仅在发起同步失败时切换。流已正常产出后的中途断开**不会**切下一条（内容已交给宿主，切了会重复），但会记录真实原因并冷却该渠道，下一轮自动跳过。
- **不做**供应商登录 / 签到、额度查询看板、外发 OpenAI 兼容端点、时段链或角色链。这是模型池，不是账号池。
- 运行时注册的渠道（无 baseURL + Key）只能走宿主探测，测不出「上游目录」。
- 界面文案目前**只有中文**（`t = (k) => k`，未接 locale 表）。英文 README 描述的是同一套界面。
- 面板统计的用量只覆盖「走模型池」+「能回放到会话日志」的部分；宿主其它路径的消耗不在台账里。

## 许可

MIT
