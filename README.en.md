# dsh-model-pool

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/pure-cow-horse/dsh-model-pool?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/pure-cow-horse/dsh-model-pool/stargazers"><img src="https://img.shields.io/github/stars/pure-cow-horse/dsh-model-pool?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/pure-cow-horse/dsh-model-pool/commits/main"><img src="https://img.shields.io/github/last-commit/pure-cow-horse/dsh-model-pool?style=flat-square" alt="last commit"></a>
</p>

English | [中文](./README.md)

Turn a pile of half-free, rate-limited, quietly-expiring model channels into **one pool that switches channels for you**.

Once you have seven or eight providers configured in DSH, the daily problem stops being "no models" and becomes: this one is rate-limiting today, that one burned its quota, a free channel went dark without notice, this model can't see images and I just pasted one. This plugin pulls those decisions into a single panel and hands the switching itself to a virtual provider that acts when a request is made — you pick a scheme, not a vendor.

Three things it does:

| What you do in the panel | What it does behind it |
| --- | --- |
| See **which vendor has which model, and whether it answers** | Merge three model sources, probe and minimal-request test, pull the upstream catalog |
| Decide **the order to try them in** | Named schemes with an ordered chain, drag-ordering, three built-in sort strategies |
| Let it **try the next one automatically** | Virtual provider `ModelPool`: request-level failover, cooldowns, exponential backoff, multimodal avoidance |

## Install

```sh
# from GitHub (recommended)
dsh plugin --profile desktop add github:pure-cow-horse/dsh-model-pool
```

Restart DSH afterwards. Use `--profile desktop` for the desktop build, `--profile web` for the web one.

<details>
<summary>Other install paths</summary>

From a local directory (edits take effect on restart; useful while developing):

```sh
dsh plugin --profile desktop add file:C:/path/to/dsh-model-pool
```

Or edit `~/.dsh/profiles/<profile>/package.json` directly:

```json
{
  "dependencies": { "dsh-model-pool": "file:<absolute path to the plugin>" },
  "dsh": { "profile": { "bundles": ["dsh-model-pool"] } }
}
```

Then `pnpm install` and restart.

</details>

### Before you install

- At least one model provider configured in DSH (`llm-pi-ai.providers`), or a connector plugin (WorkBuddy / Qoder / Trae …) that registers channels at runtime.
- The official `@deepseek-ai/*` packages are declared as `peerDependencies` and come from the host; they must not be installed separately.

> **Relationship to `dsh-llm-fallbacks` / `JiahaoXxX/dsh-model-pool`:** this plugin is **not** a fork of either. Code and data layout are independent (state lives in `model-pool.json`, the profile row id is `dsh-model-pool`), so it does not collide with `llm-fallbacks`. Both do failure chains, though — running both means two switches and one wasted round trip per failure, so keep only one enabled.

## The panel

Three entry points, one component: the sidebar item "模型池", a settings-page section, and a main-area `model-pool` panel.

Three tabs:

| Tab | What it is for |
| --- | --- |
| **Model list** | What models exist, batch testing, pull upstream, apply to config, enable/disable providers |
| **Schemes & chains** | Build schemes, order them, test a chain, tune effort and cooldowns |
| **Usage** | Token ledger by day × source × channel × model, CSV export |

### Model list

**Source merging.** Models come from three places, unioned and deduplicated by provider:

1. models statically configured in `llm-pi-ai.providers`;
2. channels registered at runtime through `registerAdapter` (connector plugins such as Qoder, Trae, WorkBuddy);
3. a local catalog cache scan — `.workbuddy-catalog.json`, `.workbuddy-ai-catalog.json`, `.workbuddy<N>-catalog.json`, `.qoder-catalog.qoder-cn.json`, `.qoder-catalog.qoder.json`.

**Making it scannable.** Providers are collapsible groups with collapse-all / expand-all; each group lists the first 20 only (a thousand rows will freeze the page) with an "expand the remaining N" button; searching or filtering auto-expands everything, so a hit is never invisible. Clicking a column header opens a filter panel (provider / family / free / status); columns **combine**, sorting happens within a column. Counts **ignore that column's own condition** — otherwise picking "free = yes" zeroes every other option and the data looks lost.

**Testing.** The per-row "测" button, or "测试全部" on a provider's group header, sends one minimal request and marks the model usable or not, with latency and an error summary. Configured channels are probed directly (`GET {baseURL}/models` plus a minimal chat); runtime channels go through the host's `llm.stream` — they have no baseURL and key to dial directly, and going through the host is the accurate path. While in flight the button reads "测中…" and is disabled; failures land in the results too, never swallowed. Results persist across reloads.

**Pulling upstream.** "拉上游" on a group header calls that channel's `GET {baseURL}/models` and brings the **full upstream catalog** (including models not yet in your config) into the panel. The catalog has its own search box, one keyword per vendor, independent of the others. "Select all / invert" applies only to **the current search results** and merges with existing selections — searching and then hitting select-all will not deselect your other models.

**Apply / disable.** "接入选中 N 个" writes the selection back to `llm-pi-ai.providers.<provider>.models`. Semantics are **whole-list replacement** (anything unchecked is removed from DSH); it backs up the patch first, retries on revision conflicts, reads back to verify, and fails loudly on mismatch. "禁用" on a group header removes the provider from `llm-pi-ai.providers` (the full definition is stashed in `model-pool.json` under `disabledProviders`), so the host stops registering it and it **disappears from the conversation model picker**; "启用" in the disabled bar writes it back verbatim. No key, baseURL or model list is lost. (The host has no per-provider disable field, so this is the only way; disabling a provider that is on a chain reports how many entries are affected.)

**Aliases.** Qoder registers its internal upstream codenames (`qmodel_38max`, `dfmodel`, `gmodel` …) as model ids, and the panel used to show those raw. Before returning `/models` the plugin adds a readable `modelName` for the known codenames — **display field only**: `modelId` and `key` stay untouched, because a readable name leaking into the chain means the upstream won't recognize it and the whole chain breaks, silently, until someone sends a message. Two codenames differ by generation between the CN and international builds (`mmodel` is MiniMax-M2.7 on CN, M3 internationally), so those are overridden per provider.

### Schemes and chains

- Multiple named schemes ("pure deepseek", "pure glm", "coding workhorse" …), one active.
- **+ add checked models to the current scheme**: deduplicated, appended to the end, order preserved.
- **New scheme from selection**: save the checked set as a new scheme.
- **Three built-in sorts** (whole-chain replacement): cluster by family, latency first (by last measured latency), free first.
- Drag to reorder, remove a single entry, switch the active scheme.
- **Test the current chain**: tests only the active scheme's entries (not the whole catalog) in chain order, returning usable / unusable / skipped with latency, showing a status dot and timing right on each row. Concurrency defaults to 4, accepts 1–8.
- **Per-row test**: an entry may come back from a full check with neither a green nor a red dot, leaving you unsure whether it works. The row button sends one request and writes into the same results table the full check uses, so the two views never disagree.
- **Context window**: type `128k` / `1m` in the panel to hand the host a **global override** (leave empty to use each model's own default).
- **Thinking effort**: one scheme-level dropdown (uniform across the chain, so a failover keeps the same effort), plus a per-provider effort bar next to the composer that renders only the levels **that provider actually supports**, remembered per provider. Effort is a per-model capability — different vendors expose different sets, so it cannot be hardcoded.

### Usage

Token accounting by **day × source × channel × model**, merged from two sources:

1. **Pool ledger** — the `usage` blocks the pool intercepts in the candidate stream. Every conversation that goes through the pool passes here, and at that moment the plugin knows exactly which channel and model produced it.
2. **Session log replay** — when you pick a specific model in the model list, the host bypasses the pool entirely and the pool sees nothing. That part is recovered by replaying session logs: it reads `request/header` (`data.header.config.provider/model`) and the `usage` in assistant events, skips requests where `provider === "ModelPool"` (the ledger already counted those; not skipping would count one request twice), dedupes by `turn:step` (both the mid-turn snapshot and the final message can carry usage, so it overwrites rather than accumulates), and splits **multi-frame zstd** on the `0xFD2FB528` magic to decompress frame by frame.

Accounting rules:

- `attempts` +1 per attempt; `requests` +1 only after **text or a tool call was produced**, `errors` otherwise. One conversation that tried 3 candidates before succeeding is 3 attempts / 1 request / 2 errors.
- Tokens are added **only when the upstream actually reports them** — failed streams usually carry no usage, so no consumption is invented, no zeros padded, no estimating.
- **Cache reads are a separate column**: in this project cache reads routinely reach ten times the input volume, and folding them into input destroys the number you actually care about.
- Days are cut on **local time** (UTC would file everything after 8 pm under "tomorrow").

The page has a **source** filter (all / pool / direct): the overview and the daily breakdown recompute with it, while **the reconciliation row always stays full-volume** — it exists to prove data integrity, and following the filter would defeat that. One-click CSV export (with BOM, so Excel splits columns correctly).

## Failover engine (virtual provider `ModelPool`)

In the model picker, `Auto` follows the panel's active scheme; each scheme also shows up as its own selectable virtual model (the virtual model id is the scheme name).

**Request-level failover.** Entries are tried in chain order. A failure at connection time puts that entry on cooldown and moves to the next; cooldowns expire on their own; if everything fails the last error is thrown. Trigger codes: `AUTH`, `QUOTA`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`.

**Cooldowns and backoff.** Base cooldown defaults to 60 s, range 5 s – 1 h, adjustable in the panel (stored as `cooldownMs`). Consecutive failures back off by powers of two (1x, 2x, 4x …) capped at 500 s by default, range 10 s – 1 h (stored as `maxBackoffMs`); a success resets that channel's streak. One click clears every cooldown and backoff streak.

**Multimodal avoidance.** Requests carrying images are detected (`image` / `image_url` / `input_image` blocks, `part.image`, an `image/*` mime, `options.images`), and text-only models on the chain are skipped **without counting as a failure and without a cooldown**, handing the request straight to the next vision-capable model. Later text-only requests are unaffected — the first text model still takes them.

**Rejected-effort memory.** After a channel explicitly answers `UNSUPPORTED_REASONING_EFFORT`, that level is remembered for 10 minutes and the default level is used instead, so you stop burning a round trip per turn; the TTL self-heals and an accepted level clears the memory.

**Diagnostics.** The "failed / skipped this time" panel lists each attempt's real upstream status code, HTTP error, duration and `rawError`, with a "详情" dialog for the full payload. `/api/model-pool/current` also reports `cooling` and `routeConflicts`.

**Composer label.** While `ModelPool` is selected, the model name next to the chat input shows the actual hit as "provider / model · level" with a compact level switcher; selecting any other model falls back to the plain model name. This cell is a `single` slot in DSH (a second registration at the same priority throws, and only the lowest priority renders), and this plugin holds it at `priority: -2` — so the host's own model badge and connector pills **do not render at the same time**. That is inherent to a single slot, not something drawn on top.

## Data files

| File | Contents |
| --- | --- |
| `<profile.dir>/model-pool.json` | Schemes, active scheme, chains, `providerEfforts`, `cooldownMs`, `maxBackoffMs`, `contextWindow`, `disabledProviders`, `probeCache`. Written atomically (tmp + rename) |
| `<profile.dir>/model-pool-probe.json` | Last connectivity test status / latency / error. No upstream credentials |
| `<profile.dir>` or `~/.dsh`/`model-pool-lastuse.json` | Last actual hit, kept across restarts (only accepted if under 24 h old) |
| `~/.dsh/model-pool/usage/YYYY-MM-DD.json` | Token ledger, one file per day, atomic writes, 180-day retention |
| `~/.dsh/model-pool-diag.log` | Diagnostics. **Errors only by default**; set `DSH_MODEL_POOL_DIAG=1` for everything. Rotates to `.log.1` past 5 MB, one generation kept |
| `<profile.dir>/cordis.patch.yml.bak-modelpool-<timestamp>` | Pre-write config backups, **10 most recent kept** |

The plugin **does not modify** `llm-pi-ai` config, with exactly two exceptions — "apply selected models" and "disable provider", both from the panel, both backed up first.

## HTTP API

Everything under `/api/model-pool/`, 13 routes, meant for the local same-origin panel only (cross-origin is refused; writes accept POST only):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/providers` | Provider list (no secrets) |
| GET | `/models` | Pull the upstream catalog and merge configured models |
| POST | `/upstream` | Pull one provider's full `/v1/models` catalog |
| POST | `/apply-models` | Write the selection back to DSH config |
| POST | `/toggle-provider` | Enable / disable a provider |
| GET/POST | `/chain` | Read schemes and chains / save schemes, switch active |
| GET | `/current` | Last hit + attempts + cooldowns + route conflicts |
| GET | `/efforts` | Thinking levels each candidate model actually supports |
| POST | `/test` | Minimal request test for one model |
| POST | `/test-chain` | Test the current (or named) scheme's chain only |
| GET/POST | `/probe-results` | Read / write the last test results |
| POST | `/clear-cooldown` | Clear cooldowns and backoff streaks |
| GET | `/usage?days=7` | Daily × model token ledger (read-only, `days` capped at 180) |

## Regression probes

Most of the logic lives in plugin lifecycle and render closures where unit tests cannot reach it, so every point that **fails silently rather than loudly** gets its own static or local-fake-upstream probe.

```sh
node probes/run-all.mjs          # run them all
```

**21 probes, 264 assertions, currently all green.**

| Probe | Assertions | What it pins down |
| --- | --- | --- |
| verify-alias-boundary | 4 | Aliases touch `modelName` only; `modelId` / `key` stay raw |
| verify-cache-hygiene | 9 | 5 `/test` calls in a batch describe once; caches invalidate on write; backups trimmed past 10 |
| verify-chain-row-test | 8 | The row button keys on the chain entry itself and shares one results table |
| verify-clear-cooldown | 16 | Single and full clears, `lastUse` untouched, local POST only |
| verify-diag-log | 7 | Errors only by default, full log with the env flag, 5 MB rotation keeping one generation |
| verify-error-reporting | 17 | Mid-stream breaks record `midStream` plus the real reason and a cooldown; `error` can never be null |
| verify-exponential-backoff | 16 | 2^n backoff, cap honoured, reset on success, `streak` reported |
| verify-model-header-filter | 24 | Header filter counts ignore their own column; filter and display share one predicate; no second entry point |
| verify-model-list-ux | 13 | `th` sticks; the row button enters an in-flight state and records failures |
| verify-multimodal-guard | 14 | Image requests skip text-only models with no cooldown; later text requests unaffected |
| verify-provider-test-button | 13 | "Test all" covers the whole provider, skips unregistered models, stops propagation |
| verify-provider-toggle | 15 | A disabled provider is gone from config, restorable losslessly, and gone from `/models` immediately |
| verify-route-disposal | 10 | Every route's disposer is captured and released in reverse inside `ctx.effect` |
| verify-session-replay | 13 | `ModelPool` skipped, `turn:step` deduped, multi-frame zstd decompressed frame by frame |
| verify-single-test | 12 | Runtime channels no longer 404; the state file invalidates on mtime |
| verify-test-chain | 14 | Only chain entries, order preserved; configured channels direct, runtime channels via the host |
| verify-tool-call-output | 8 | A tool-call-only turn counts as output; only `reasoning-delta` still means empty |
| verify-unsupported-effort-skip | 6 | A rejected level is remembered for 10 minutes and the TTL self-heals |
| verify-upstream-apply | 13 | Catalog pull, whole-list replacement, existing fields preserved, backup first, readback mismatch must throw |
| verify-usage-ledger | 18 | No padding on failure, cache reads separate, local-time day cuts, 180-day prune touching only its own files |
| verify-usage-source-filter | 12 | Overview and daily recompute under filter; the reconciliation row stays full-volume |

Every probe accepts `POOL_PROBE_TARGET=installed` to test the copy actually running in your profile instead of this repo's `dist/`.

## Limits

- **Request-level failover only**: switching happens when initiating the connection fails. A break *after* a stream started producing does **not** switch (the content is already handed to the host; switching would duplicate it), but the real reason is recorded and that channel gets a cooldown so the next turn skips it.
- **Not** vendor login/check-in, not a credits dashboard, not an outward OpenAI-compatible endpoint, not time-slot or role chains. This is a model pool, not an account pool.
- Runtime-registered channels (no baseURL or key) can only be probed through the host, and have no upstream catalog to pull.
- The UI is **Chinese only** today (`t = (k) => k`, no locale table wired). The English README describes that same interface.
- The usage panel covers what went through the pool plus what could be replayed from session logs; traffic on other host paths is not in the ledger.

## License

MIT
