<div align="center">

# ⏩ pi-onward

[pi](https://pi.dev) 的一轮以错误结束时，按规则自动续跑：发一条「继续」，或者静默重发同一个请求

[📦 安装](#-安装) · [⚙️ 工作方式](#️-工作方式) · [📝 设置文件](#-设置文件) · [📋 常见规则](#-常见规则) · [🧰 命令速查](#-命令速查) · [❓ 常见问题](#-常见问题)

</div>

管的是「一轮已经失败收尾之后怎么办」，例如中转间歇吐出的 `401 Invalid API key`、pi 自带重试用完后仍然失败的 `429`、`502`、`Connection error.`。不改 pi 自带的重试。

没有内置规则：哪些错误续跑、怎么续跑，全由你在设置文件里写。[常见规则](#-常见规则)给了一份可以直接用的。

## 📦 安装

| 准备项  | 说明              |
| :------ | :---------------- |
| pi      | 1.4.0 或更高      |
| Node.js | 22.19.0 或更高    |

```bash
pi install git:github.com/cobia68/pi-onward
```

或者从本地目录装（没有运行时依赖，不需要 `npm ci`）：

```bash
git clone https://github.com/cobia68/pi-onward.git
pi install ./pi-onward
```

重开 pi 或输入 `/reload`，再输入 `/onward`：看到「onward：开，没有可用的规则…」就是装好了。这时出错还不会续跑：把仓库里的 [`example.json`](example.json) 复制成 `~/.pi/agent/onward.json`（已有的话先备份），再 `/onward reload`。它的规则就是下面的[常见规则](#-常见规则)。

> [!WARNING]
> 以前用过单文件的 `~/.pi/agent/extensions/auto-continue.ts`，要先删掉它。两个同时装，出错时会各续跑一次；插件启动时发现 `/auto-continue` 还在会提醒。旧的 `auto-continue.json` 会被自动读进来，见[从 auto-continue 迁移](#从-auto-continue-迁移)。

## ⚙️ 工作方式

一轮收尾时，最后一条助手消息是 `stopReason: "error"`、并且命中了一条规则，才处理；按 Esc 结束的（`aborted`）、正常结束的、没命中规则的都不碰。下面的方式、上限、间隔都是规则的参数，规则没写的取 `defaults`。

两种方式都在 pi 的收尾边界 `agent_before_settle` 上等一会儿，再用 `continue: true` 让这一轮接着跑。等待和续跑都在这一轮之内，所以交互、`pi -p`、RPC、[subagent 子会话](#-常见问题)里行为一样。

| 方式 | 做法 | 留下什么 |
| :--- | :--- | :------- |
| `message`（默认） | 追加一条消息（默认「继续」）再接着跑 | 会话里多一条看得见的扩展消息，模型把它当用户消息读 |
| `silent` | 用 `context_edit` 把失败的那条从模型上下文里省略，重发同一个请求 | 不写消息；原始记录里还留着失败的那次和一条不可见的 `context_edit` |

等待期间这一轮还算忙，和 pi 自带的重试一样：按 Esc 打断等待，不再续跑；等待时输入的消息优先，pi-onward 让路，由 pi 接着处理你的消息；`/onward off` 也会立刻打断。

**上限**（每次续跑都是真实请求）：

- 连续失败时，每条规则最多续跑 `maxRetries` 次，默认 10。
- 同一个错误连续出现超过 `sameErrorLimit` 次就彻底停，默认 10，也就是第 11 次时停。是不是同一个错误按归一化后的错误文案判断：大小写、空白、`request id`、UUID、长数字、长十六进制串都不算差异。换了错误就重新数。
- 停手只提醒一次。

**间隔**：默认按次数增长并封顶，第 n 次等 `min(3 秒 × n, 15 秒)`，即 3 → 6 → 9 → 12 → 15 → 15 … 秒，10 次合计 2 分钟。也可以写死一份列表。

**计数清零**：续跑之后助手正常返回过一次（包括中间的工具轮）就算恢复，次数和同错计数都从头算；一轮正常结束、按 Esc、用户自己发起新一轮也清零。所以上限管的是「连着失败」，不是一轮里的总次数：只要每次续跑后都有进展，就会一直续下去。

## 📝 设置文件

`~/.pi/agent/onward.json`（环境变量 `PI_ONWARD_CONFIG` 可改路径）。没有这个文件、或者里面没有可用的规则，出错时什么都不做，启动时提醒一句。`/onward` 命令只改 `enabled` 和 `defaults`，`rules` 要手写，改完 `/onward reload`。

下面是全部字段的说明。`//` 注释只为说明，真实文件是纯 JSON，不能写注释；可以直接复制的见[常见规则](#-常见规则)。

```jsonc
{
  "enabled": true,
  "defaults": {
    "mode": "message",          // message | silent
    "prompt": "继续",            // message 模式发的消息
    "maxRetries": 10,           // 0–50
    "sameErrorLimit": 10,       // 1–100
    "retryBaseMs": 3000,        // 按次数增长：第 n 次等 min(base × n, cap)
    "retryCapMs": 15000,
    "retryDelaysMs": []         // 非空时按列表来，最后一个值重复；优先于 base/cap
  },
  "rules": [
    {
      "name": "relay-auth",
      "when": { "match": "401|invalid\\s*(api\\s*)?(key|token)", "provider": "welfare-*" },
      "then": { "action": "continue", "mode": "silent" },
      "budget": { "maxRetries": 20, "retryCapMs": 10000 }
    },
    {
      "name": "everything-else",
      "then": { "prompt": "上一步出错了（{error}），接着做，第 {attempt}/{max} 次" }
    }
  ]
}
```

### 规则

一条规则由三部分组成：`when` 是条件，`then` 是动作，`budget` 是预算。

- **没有内置规则**。没写 `rules`、或者写的全被丢掉，出错时什么都不做。`defaults` 只是规则没写的参数的默认值，本身不会触发续跑。
- 按顺序第一条命中的生效，**没命中的错误不处理**。想兜底就在最后放一条不带 `when` 的规则。
- `budget.maxRetries: 0` 的规则命中就停、只提醒，也挡住后面的兜底。适合额度用完这类重试没用的错误。
- `enabled: false` 的规则保留但跳过。
- 每条规则有自己的续跑次数；「同一个错误连续几次」是全局的，但用的是当前命中规则的上限。

| 字段 | 说明 |
| :--- | :--- |
| `name` | 规则名，出现在通知里；不写时按位置叫 `rule-1`、`rule-2` |
| `when.match` | 正则，大小写不敏感，对原始错误文案匹配 |
| `when.provider` / `when.model` | 通配，只有 `*` 有特殊含义，大小写不敏感，整串匹配 |
| `when.stopReason` | 目前只支持 `"error"`（也是默认） |
| `then.action` | 目前只支持 `"continue"`（也是默认） |
| `then.*` / `budget.*` | 覆盖 `defaults` 里的同名字段，`budget` 覆盖 `then` |

`prompt` 里可以写 `{attempt}`（第几次）、`{max}`（最多几次）、`{error}`（错误摘要）、`{rule}`（规则名）。

看不懂的条件或动作会让整条规则被丢掉，免得它匹配得比写的人以为的更宽；看不懂的参数只忽略那一项。丢掉和忽略的内容用 `/onward rules` 查看。设置文件不是合法 JSON 时一条规则都没有，启动时提醒，而且命令不会改写它。

### 从 auto-continue 迁移

`onward.json` 不存在而 `~/.pi/agent/auto-continue.json` 存在时，旧文件里的扁平字段会当作 `defaults` 读进来；旧文件不删，由你决定。

只迁参数，不迁行为：旧扩展任何错误都续跑，这里没有内置规则，读进来之后出错仍然不续跑。想保持原来的行为：先用一次命令（比如 `/onward on`）把旧参数写进 `onward.json`，再在里面加一条不带 `when` 的规则 `"rules": [{ "name": "any" }]`，然后 `/onward reload`。也可以直接换成[常见规则](#-常见规则)。

## 📋 常见规则

下面这份就是 [`example.json`](example.json) 的 `rules`（那个文件还写全了 `defaults` 的默认值），可以直接存成 `~/.pi/agent/onward.json`，再 `/onward reload`。按顺序第一条命中的生效，所以「重试没用」的放在最前面；用不到的整条删掉。

```json
{
  "rules": [
    {
      "name": "quota",
      "when": { "match": "insufficient[\\s_-]*quota|exceeded your current quota|quota exceeded|out of budget|billing|usage limit|余额不足|额度不足|额度已用尽" },
      "budget": { "maxRetries": 0 }
    },
    {
      "name": "context-overflow",
      "when": { "match": "context[\\s_-]*(length|window)|prompt (is )?too long|maximum context|request_too_large" },
      "budget": { "maxRetries": 0 }
    },
    {
      "name": "auth",
      "when": { "match": "\\b401\\b|unauthorized|authentication|invalid[\\s_-]*(x-)?(api[\\s_-]*)?(key|token)" },
      "then": { "mode": "silent" },
      "budget": { "maxRetries": 20, "retryCapMs": 10000 }
    },
    {
      "name": "rate-limit",
      "when": { "match": "\\b429\\b|rate[\\s_-]*limit|too many requests|resource[\\s_-]*exhausted" },
      "then": { "mode": "silent" },
      "budget": { "maxRetries": 5, "retryDelaysMs": [30000, 60000, 120000] }
    },
    {
      "name": "server",
      "when": { "match": "\\b(500|502|503|504|520|524|529)\\b|overloaded|server[\\s_-]*error|internal[\\s_-]*error|bad gateway|service[\\s_-]*unavailable|upstream|负载已饱和" },
      "then": { "mode": "silent" }
    },
    {
      "name": "network",
      "when": { "match": "connection|network|econnreset|econnrefused|etimedout|socket hang up|fetch failed|timed? ?out|terminated" },
      "then": { "mode": "silent" }
    },
    {
      "name": "fallback",
      "then": { "mode": "message", "prompt": "上一步出错了（{error}），接着做" },
      "budget": { "maxRetries": 3, "sameErrorLimit": 2 }
    }
  ]
}
```

| 规则 | 管什么 | 怎么做 |
| :--- | :----- | :----- |
| `quota` | 额度、余额用完（`insufficient_quota`、`billing`、`usage limit`、`余额不足`） | 次数 0：只提醒，不续跑，也不落到后面的兜底 |
| `context-overflow` | 上下文超长 | 次数 0：pi 已经自动压缩并重来过一次，再发一样会超。手动 `/compact` 或换更大上下文的模型 |
| `auth` | 中转间歇吐出的 `401`、`Invalid API key` | 静默重发，最多 20 次，间隔封顶 10 秒；key 真的错了的话，同一个错误连续超过 10 次就停 |
| `rate-limit` | pi 自带重试用完后仍然 `429` | 静默重发，间隔拉长到 30 秒 → 1 分 → 2 分，最多 5 次 |
| `server` | `5xx`、`overloaded`、上游负载饱和 | 静默重发，默认间隔 |
| `network` | `Connection error.`、`ECONNRESET`、超时、`fetch failed` | 静默重发，默认间隔 |
| `fallback` | 上面都没命中的错误 | 发一条带错误摘要的消息，让模型自己接着做；最多 3 次，同一个错误连续超过 2 次就停。不想兜底就删掉 |

- 只想对某个中转生效：在 `when` 里加 `"provider": "你的中转-*"`（只有 `*` 是通配）。
- 各家的错误文案不一样。没命中的话，看通知里的错误摘要，补进对应规则的 `match`。`match` 对原始错误文案匹配，大小写不敏感，JSON 里的反斜杠要写两遍。

## 🧰 命令速查

| 命令 | 作用 |
| :--- | :--- |
| `/onward` | 当前设置、设置来源、恢复前已续跑几次 |
| `/onward on` · `off` | 开关 |
| `/onward message` · `silent` | 默认续跑方式 |
| `/onward 10` | 默认最多续跑 10 次 |
| `/onward 5s,10s,30s` | 写死间隔列表（单位 `ms` `s` `m`） |
| `/onward base=3s cap=15s` | 按次数增长的基数与封顶 |
| `/onward ramp` | 清掉间隔列表，回到按次数增长 |
| `/onward same=10` | 同一个错误连续 10 次后，第 11 次彻底停 |
| `/onward prompt=继续` | message 模式发的消息（吃掉整行剩下的部分） |
| `/onward rules` | 列出规则，以及设置文件里被丢掉、被忽略的内容 |
| `/onward reload` | 重新读设置文件 |
| `/onward reset` | 去掉 `enabled` 和 `defaults`，保留手写的 `rules` |
| `/onward help` | 用法 |

可以一次写几项，例如 `/onward silent 20 same=5 base=2s cap=10s`。

除了 `on` / `off`、`rules`、`reload`、`reset`、`help`，其余命令改的都是 `defaults`：规则自己没写的参数用它。命令不会新增规则。

## ❓ 常见问题

**和 pi 自带的重试是什么关系？**
pi 自带的重试（`settings.json` 的 `retry`）先跑，它只处理瞬时错误（overloaded、429、5xx），不处理 401。它重试用完、这一轮以错误收尾之后，才轮到 pi-onward。两者叠加的总次数是相乘的。如果 `retry.maxRetries` 已经调得很大，pi-onward 的规则可以只匹配 401 这类 pi 不重试的错误。

**和 `pi-retry` 有什么不同？**
`pi-retry` 会接管 pi 自带的重试，并且明确不重试 `invalid API key`。pi-onward 不碰 pi 自带的重试，专门处理收尾之后的错误，并且按规则决定怎么续跑、续跑几次。

**subagent 里出错也会续跑吗？**
会，前提是子会话加载了 pi-onward。[pi-subagents](https://github.com/nicobailon/pi-subagents) 的规则是：

- 后台（`async: true`）子会话会加载你装的扩展，除非 agent 写了 `extensions`。
- 前台子会话跑在主进程里，**从不加载**主会话的扩展，要在 `~/.pi/agent/settings.json` 里给它们加上：

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["~/.pi/agent/git/github.com/cobia68/pi-onward/src/extension/index.ts"]
  }
}
```

路径指向装好的 pi-onward 入口：用 `pi install git:...` 装的在上面这个位置，从本地目录装的就写那个目录下的 `src/extension/index.ts`。写了自己 `subagentOnlyExtensions` 的 agent 不吃这个默认值，要把路径加进它自己的列表。

后台子会话因此可能加载两份 pi-onward（指向同一个文件时 pi 会去重）；即使是两份不同的副本，同一个会话里也只有先加载的那份干活，不会续跑两次。子会话没有界面，续跑和停手都不弹提示。

**等待时能打断吗？**
能。按 Esc 打断等待，不再续跑；直接输入消息也行，pi-onward 让路，先处理你的消息，计数清零。

## 🛠️ 开发

```bash
npm install --no-bin-links   # 仓库在不支持符号链接的共享目录上时加 --no-bin-links
npm run check                # biome + tsc + 测试 + 用 pi 的加载器加载一遍
```

| 目录 | 内容 |
| :--- | :--- |
| `src/policy/` | 纯逻辑，不碰 pi 和文件：什么算失败（`failure`）、命中哪条规则（`rules`）、按什么参数（`policy`）、等多久（`delay`）、什么时候停（`tracker`）；`config` 把它们拼成设置文件的模型 |
| `src/extension/` | 接 pi：`onward` 处理事件并续跑，`command` 是 `/onward`，`settings` 读写设置文件，`text` 是给人看的文字，`index` 把它们装起来 |
| `tests/` | `node:test`，目录与 `src/` 对应；`tests/support/fake-pi.ts` 按 pi 的真实事件顺序发事件 |
