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
pi install npm:@cobia/pi-onward
```

以前从 Git 仓库或本地目录装过的，先用 `pi list` 找到原来的来源，`pi remove <来源>` 删掉再装；在 `defaultSubagentOnlyExtensions` 里写过入口路径的，按[常见问题](#-常见问题)里 subagent 那一条改成新的位置。

重开 pi 或输入 `/reload`，再输入 `/onward status`：看到「💤 onward：开，但没有可用的规则…」就是装好了。这时出错还不会续跑：把包里的 [`example.json`](example.json)（装在 `~/.pi/agent/npm/node_modules/@cobia/pi-onward/example.json`）复制成 `~/.pi/agent/onward.json`（已有的话先备份），再 `/onward reload`。它的规则就是下面的[常见规则](#-常见规则)。

## ⚙️ 工作方式

一轮收尾时，最后一条助手消息是 `stopReason: "error"`、并且命中了一条规则，才处理；按 Esc 结束的（`aborted`）、正常结束的、没命中规则的都不碰。下面的动作、上限、间隔都是参数：设置文件顶层写的是默认值，规则里同名的字段覆盖它。

续跑都在 pi 的收尾边界 `agent_before_settle` 上等一会儿，再用 `continue: true` 让这一轮接着跑。等待和续跑都在这一轮之内，所以交互、`pi -p`、RPC、[subagent 子会话](#-常见问题)里行为一样。

| `action` | 做法 | 留下什么 |
| :--- | :--- | :------- |
| `message`（默认） | 追加一条消息（默认「继续」）再接着跑 | 会话里多一条看得见的扩展消息，标着「⏩ onward · 续跑 2/10 · auth」，模型只读到消息本身，当用户消息读 |
| `resend` | 用 `context_edit` 把失败的那条从模型上下文里省略，重发同一个请求 | 不写消息；原始记录里还留着失败的那次和一条不可见的 `context_edit` |
| `stop` | 不续跑，只提醒一次；后面的规则也不再看 | 什么都不留 |

状态栏写着进度：续跑时是「⏩ 续跑 2/10 · auth」（第几次、最多几次、哪条规则），停了是「🛑 续跑已停 · auth」或「🛑 不续跑 · quota」；恢复、或者你发新消息时清掉。会话里的提示只补状态栏没有的：续跑时是「onward：3 秒后静默重发」，停手时说为什么、怎么办，不重复次数和规则名。`/onward status` 和启动提示用同一套图标：⏩ 在管，💤 不会续跑（关了或没有规则），🛑 停了或设置文件要先修。`pi -p` 没有界面，不写状态栏也不提示；RPC 下 pi 把它们发给客户端，显不显示由客户端定。

等待期间这一轮还算忙，和 pi 自带的重试一样：按 Esc 打断等待，不再续跑；等待时输入的消息优先，pi-onward 让路，由 pi 接着处理你的消息；`/onward off` 也会立刻打断。

**上限**（每次续跑都是真实请求）：

- 连续失败时，每条规则最多续跑 `maxRetries` 次，默认 10。
- 同一个错误最多续跑 `maxSameError` 次，默认 10：再出现就彻底停。是不是同一个错误按归一化后的错误文案判断：大小写、空白、`request id`、UUID、长数字、长十六进制串都不算差异。换了错误就重新数。
- 停手只提醒一次。

**间隔** `delay`，每个值都带单位（`ms`、`s`、`m`）：

- `3s..15s`（默认）：按次数增长并封顶，第 n 次等 `min(3 秒 × n, 15 秒)`，即 3 → 6 → 9 → 12 → 15 → 15 … 秒，10 次合计 2 分钟。
- `30s,1m,2m`：按列表来，最后一个值重复。

**计数清零**：续跑之后助手正常返回过一次（包括中间的工具轮）就算恢复，次数和同错计数都从头算；一轮正常结束、按 Esc、用户自己发起新一轮也清零。所以上限管的是「连着失败」，不是一轮里的总次数：只要每次续跑后都有进展，就会一直续下去。

## 📝 设置文件

`~/.pi/agent/onward.json`：在 pi 的配置目录里，设了 `PI_CODING_AGENT_DIR` 就跟着它；环境变量 `PI_ONWARD_CONFIG` 可以直接指定路径。没有这个文件、或者里面没有规则，出错时什么都不做，启动时提醒一句。`/onward` 命令只改 `enabled` 和顶层的参数，`rules` 要手写，改完 `/onward reload`。

顶层写的参数就是每条规则的默认值，规则里只写和顶层不同的字段。下面是全部字段的说明，`//` 注释只为说明，真实文件是纯 JSON，不能写注释；可以直接复制的见[常见规则](#-常见规则)。

```jsonc
{
  "enabled": true,               // 插件开关；不是默认值
  "action": "message",           // message | resend | stop
  "prompt": "继续",              // message 发的消息
  "maxRetries": 10,              // 1–50
  "maxSameError": 10,            // 1–100
  "delay": "3s..15s",            // 或 "5s,10s,30s"
  "rules": [
    {
      "name": "relay-auth",
      "when": {
        "error": "401|invalid\\s*(api\\s*)?(key|token)",
        "provider": "welfare-*"
      },
      "action": "resend",
      "maxRetries": 20,
      "delay": "3s..10s"
    },
    {
      "name": "everything-else",
      "prompt": "上一步出错了（{error}），接着做，第 {attempt}/{max} 次"
    }
  ]
}
```

### 规则

一条规则由条件 `when` 和参数组成，参数的名字和顶层一样。

- **没有内置规则**。没写 `rules`，出错时什么都不做。顶层的参数只是规则没写时的默认值，本身不会触发续跑。
- 按顺序第一条命中的生效，**没命中的错误不处理**。想兜底就在最后放一条不带 `when` 的规则。
- `"action": "stop"` 的规则命中就停、只提醒，也挡住后面的兜底。适合额度用完这类重试没用的错误。
- `enabled: false` 的规则保留但跳过。
- 每条规则有自己的续跑次数；「同一个错误连续几次」是全局的，但用的是当前命中规则的上限。

| 字段 | 说明 |
| :--- | :--- |
| `name` | 规则名，出现在通知里，不能重名；不写时按位置叫 `rule-1`、`rule-2` |
| `enabled` | `false` 时保留但跳过 |
| `when.error` | 正则，大小写不敏感，对原始错误文案匹配 |
| `when.provider` / `when.model` | 通配，只有 `*` 有特殊含义，大小写不敏感，整串匹配 |
| `action`、`prompt`、`maxRetries`、`maxSameError`、`delay` | 覆盖顶层的同名字段 |

`prompt` 里可以写 `{attempt}`（第几次）、`{max}`（最多几次）、`{error}`（错误摘要）、`{rule}`（规则名）。

**设置文件里有读不懂的地方，整份不生效**，修好之前不会自动续跑，启动时和 `/onward status` 都会提醒。拼错或不认识的键、超出范围的值、不是 `true` / `false` 的 `enabled`、重名的规则都算。不会只丢掉写坏的那部分、其余照跑：那样错误会落到更宽的规则或默认值上，比如写坏了的 `stop` 规则让额度错误落到兜底去续跑，多发真实请求。问题用 `/onward show` 查看，改完 `/onward reload`。设置文件不是合法 JSON、或者顶层不是对象时也一样；这时命令不会改写它，回复「未做任何修改」。

## 📋 常见规则

下面这份就是 [`example.json`](example.json) 的 `rules`（那个文件还写全了顶层参数的默认值），可以直接存成 `~/.pi/agent/onward.json`，再 `/onward reload`。按顺序第一条命中的生效，所以「重试没用」的放在最前面；用不到的整条删掉。

```json
{
  "rules": [
    {
      "name": "quota",
      "when": {
        "error": "insufficient[\\s_-]*quota|exceeded your current quota|quota exceeded|out of budget|billing|usage limit|余额不足|额度不足|额度已用尽"
      },
      "action": "stop"
    },
    {
      "name": "context-overflow",
      "when": {
        "error": "context[\\s_-]*(length|window)|prompt (is )?too long|maximum context|request_too_large"
      },
      "action": "stop"
    },
    {
      "name": "auth",
      "when": {
        "error": "\\b401\\b|unauthorized|authentication|invalid[\\s_-]*(x-)?(api[\\s_-]*)?(key|token)"
      },
      "action": "resend",
      "maxRetries": 20,
      "delay": "3s..10s"
    },
    {
      "name": "rate-limit",
      "when": {
        "error": "\\b429\\b|rate[\\s_-]*limit|too many requests|resource[\\s_-]*exhausted"
      },
      "action": "resend",
      "maxRetries": 5,
      "delay": "30s,1m,2m"
    },
    {
      "name": "server",
      "when": {
        "error": "\\b(500|502|503|504|520|524|529)\\b|overloaded|server[\\s_-]*error|internal[\\s_-]*error|bad gateway|service[\\s_-]*unavailable|upstream|负载已饱和"
      },
      "action": "resend"
    },
    {
      "name": "network",
      "when": {
        "error": "connection|network|econnreset|econnrefused|etimedout|socket hang up|fetch failed|timed? ?out|terminated"
      },
      "action": "resend"
    },
    {
      "name": "fallback",
      "action": "message",
      "prompt": "上一步出错了（{error}），接着做",
      "maxRetries": 3,
      "maxSameError": 2
    }
  ]
}
```

| 规则 | 管什么 | 怎么做 |
| :--- | :----- | :----- |
| `quota` | 额度、余额用完（`insufficient_quota`、`billing`、`usage limit`、`余额不足`） | `stop`：只提醒，不续跑，也不落到后面的兜底 |
| `context-overflow` | 上下文超长 | `stop`：pi 已经自动压缩并重来过一次，再发一样会超。手动 `/compact` 或换更大上下文的模型 |
| `auth` | 中转间歇吐出的 `401`、`Invalid API key` | 静默重发，最多 20 次，间隔封顶 10 秒；key 真的错了的话，同一个错误连续超过 10 次就停 |
| `rate-limit` | pi 自带重试用完后仍然 `429` | 静默重发，间隔拉长到 30 秒 → 1 分 → 2 分，最多 5 次 |
| `server` | `5xx`、`overloaded`、上游负载饱和 | 静默重发，默认间隔 |
| `network` | `Connection error.`、`ECONNRESET`、超时、`fetch failed` | 静默重发，默认间隔 |
| `fallback` | 上面都没命中的错误 | 发一条带错误摘要的消息，让模型自己接着做；最多 3 次，同一个错误连续超过 2 次就停。不想兜底就删掉 |

- 只想对某个中转生效：在 `when` 里加 `"provider": "你的中转-*"`（只有 `*` 是通配）。
- 各家的错误文案不一样。没命中的话，看 pi 显示的错误原文，补进对应规则的 `when.error`。它对原始错误文案匹配，大小写不敏感，JSON 里的反斜杠要写两遍。

## 🧰 命令速查

动作在前，参数写成 `字段=值`，字段名和设置文件一样。

| 命令 | 作用 |
| :--- | :--- |
| `/onward` | 弹出菜单，标题是现在的状态；选了就执行，`set`、`unset` 填进输入框接着写参数 |
| `/onward status` | 现在会不会续跑、规则没写的参数（做法、上限、间隔）、设置文件；正在续跑时还有进度 |
| `/onward on` · `off` | 开关 |
| `/onward show` | 各项参数的值和来源（设置文件或内置默认值）、规则、设置文件里的问题 |
| `/onward show rules` | 只看规则 |
| `/onward set 字段=值 …` | 改顶层的参数，规则没写的字段用它；例如 `set action=resend maxRetries=20 delay=5s,10s,30s` |
| `/onward unset 字段 …` | 去掉参数，退回内置默认值，例如 `unset delay` |
| `/onward reload` | 重新读设置文件 |
| `/onward reset` | 去掉 `enabled` 和顶层的参数，保留手写的 `rules` |
| `/onward --help` | 有哪些动作 |
| `/onward <动作> --help` | 这个动作的用法和说明；`set --help`、`unset --help` 还列出字段和默认值。写了 `--help` 就只显示帮助，不执行 |

- `set` 全有或全无：任何一项不合法就一项都不改，问题一起说。
- 值里有空格时加双引号：`/onward set prompt="接着做，第 {attempt} 次"`。
- 命令不会新增规则，`set rules=…` 会被拒绝。
- 输入时按 Tab 补全动作、字段名、`action` 的取值和 `--help`，选中一项再按 Tab 补下一层。每个动作后面都给 `--help`；写了 `--help` 就是结束，什么都不再补。写过的字段不再给，引号里的值不补。

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
    "defaultSubagentOnlyExtensions": [
      "~/.pi/agent/npm/node_modules/@cobia/pi-onward/src/extension/index.ts"
    ]
  }
}
```

路径指向 `pi install npm:@cobia/pi-onward` 装好的入口。写了自己 `subagentOnlyExtensions` 的 agent 不吃这个默认值，要把路径加进它自己的列表。

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
| `src/policy/` | 纯逻辑，不碰 pi 的运行时和文件（只用 pi 的类型）：什么算失败（`failure`）、命中哪条规则（`rules`）、按什么参数（`policy`，一张字段表管校验、帮助和补全）、等多久（`delay`）、什么时候停（`tracker`）；`config` 把它们拼成设置文件的模型 |
| `src/extension/` | 接 pi：`onward` 处理事件并续跑，`command` 是 `/onward`，`autocomplete` 让它的参数里按 Tab 补参数、不补文件名，`settings` 读写设置文件，`text` 是给人看的文字，`render` 画会话里的续跑消息，`install` 把它们装起来；`index` 是 pi 加载的入口，只决定设置文件放在哪里 |
| `tests/` | `node:test`，目录与 `src/` 对应；`tests/support/fake-pi.ts` 按 pi 的真实事件顺序发事件，直接装 `install`，不加载 pi 本体；补全在 pi-tui 真实的编辑器里按键。入口和设置文件的位置由 `scripts/check-extension.mjs` 用 pi 自己的加载器检查 |
