<div align="center">

# ⏩ pi-onward

[pi](https://pi.dev) 的一轮以错误结束、或者回了个空回复时，按规则自动续跑：发一条「继续」，或者静默重发同一个请求

[📦 安装](#-安装) · [⚙️ 工作方式](#️-工作方式) · [📝 设置文件](#-设置文件) · [📋 常见规则](#-常见规则) · [🧰 命令速查](#-命令速查) · [❓ 常见问题](#-常见问题)

</div>

管的是「一轮已经失败收尾之后怎么办」，例如中转间歇吐出的 `401 Invalid API key`、pi 自带重试用完后仍然失败的 `429`、`502`、`Connection error.`，以及中转偶尔返回的空回复：正常结束，但一个字都没生成。不改 pi 自带的重试。

没有内置规则：哪些错误续跑、怎么续跑，全由你在设置文件里写。[常见规则](#-常见规则)给了一份可以直接用的。

## 📦 安装

| 准备项  | 说明           |
| :------ | :------------- |
| pi      | 1.4.0 或更高   |
| Node.js | 22.19.0 或更高 |

```bash
pi install npm:@cobia/pi-onward
```

重开 pi 或输入 `/reload`，再输入 `/onward status`：看到「💤 onward：开，但没有可用的规则…」就是装好了。这时出错还不会续跑：把包里的 [`example.json`](example.json)（装在 `~/.pi/agent/npm/node_modules/@cobia/pi-onward/example.json`）复制成 `~/.pi/agent/onward.json`（已有的话先备份），再 `/onward reload`。它的规则就是下面的[常见规则](#-常见规则)。

## ⚙️ 工作方式

一轮收尾时，最后一条助手消息是 `stopReason: "error"`、并且命中了一条规则，才处理；空回复（`stopReason: "stop"`，但没有文字也没有工具调用）要有 `"when": { "empty": true }` 的规则才处理。按 Esc 结束的（`aborted`）、正常结束且有内容的、没命中规则的都不碰。下面的动作、上限、间隔都是参数：设置文件顶层写的是默认值，规则里同名的字段覆盖它。

续跑都在 pi 的收尾边界 `agent_before_settle` 上等一会儿，再用 `continue: true` 让这一轮接着跑。等待和续跑都在这一轮之内，所以交互、`pi -p`、RPC、[subagent 子会话](#-常见问题)里行为一样。

| `action`          | 做法                                                             | 留下什么                                                                                             |
| :---------------- | :--------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| `message`（默认） | 追加一条消息（默认「继续」）再接着跑                             | 会话里多一条看得见的扩展消息，标着「⏩ onward · 续跑 2/10 · auth」，模型只读到消息本身，当用户消息读 |
| `resend`          | 用 `context_edit` 把失败的那条从模型上下文里省略，重发同一个请求 | 不写消息；原始记录里还留着失败的那次和一条不可见的 `context_edit`                                    |
| `stop`            | 不续跑，只提醒一次；后面的规则也不再看                           | 什么都不留                                                                                           |

状态栏写着进度：续跑时是「⏩ 续跑 2/10 · auth」（第几次、最多几次、哪条规则），停了是「🛑 续跑已停 · auth」或「🛑 不续跑 · quota」；恢复、或者你发新消息时清掉。会话里的提示只补状态栏没有的：续跑时是「onward：3 秒后静默重发」，空回复时 pi 什么都不显示，所以前面加上「空回复，」；停手时说为什么、怎么办，不重复次数和规则名。`/onward status` 和启动提示用同一套图标：⏩ 在管，💤 不会续跑（关了或没有规则），🛑 停了或设置文件要先修。`pi -p` 没有界面，不写状态栏也不提示；RPC 下 pi 把它们发给客户端，显不显示由客户端定。

等待期间这一轮还算忙，和 pi 自带的重试一样：按 Esc 打断等待，不再续跑；等待时输入的消息优先，pi-onward 让路，由 pi 接着处理你的消息；`/onward off` 也会立刻打断。

**上限**（每次续跑都是真实请求）：

- 连续失败时，每条规则最多续跑 `maxRetries` 次，默认 10。
- 同一个错误最多续跑 `maxSameError` 次，默认 10：再出现就彻底停。是不是同一个错误按归一化后的错误文案判断：大小写、空白、`request id`、UUID、长数字、长十六进制串都不算差异。换了错误就重新数。
- 停手只提醒一次。

**间隔** `delay`，每个值都带单位（`ms`、`s`、`m`）：

- `3s..15s`（默认）：按次数增长并封顶，第 n 次等 `min(3 秒 × n, 15 秒)`，即 3 → 6 → 9 → 12 → 15 → 15 … 秒，10 次合计 2 分钟。
- `30s,1m,2m`：按列表来，最后一个值重复。

**计数清零**：续跑之后助手正常返回过一次（包括中间的工具轮；空回复不算）就算恢复，次数和同错计数都从头算；一轮正常结束、按 Esc、用户自己发起新一轮也清零。所以上限管的是「连着失败」，不是一轮里的总次数：只要每次续跑后都有进展，就会一直续下去。

## 📝 设置文件

`~/.pi/agent/onward.json`：在 pi 的配置目录里，设了 `PI_CODING_AGENT_DIR` 就跟着它。没有这个文件、或者里面没有规则，出错时什么都不做，启动时提醒一句。`/onward` 命令只改 `enabled` 和顶层的参数，`rules` 要手写，改完 `/onward reload`。某个项目要用不同的规则或参数时，在项目里另写一份，见[项目级设置](#项目级设置)。

文件开头写上 `"$schema": "https://raw.githubusercontent.com/cobia68/pi-onward/main/onward.schema.json"`，VS Code 这类编辑器就能补全字段、检查取值；全局和项目级都能写，[`example.json`](example.json) 里已经写了。写法对、意思不对的（例如正则写错、重名的规则、封顶小于起步），编辑器查不出来，以 `/onward show` 为准。

顶层写的参数就是每条规则的默认值，规则里只写和顶层不同的字段。下面是全部字段的说明，`//` 注释只为说明，真实文件是纯 JSON，不能写注释；可以直接复制的见[常见规则](#-常见规则)。

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cobia68/pi-onward/main/onward.schema.json", // 可选，给编辑器用
  "enabled": true,               // 插件开关；不是默认值
  "action": "message",           // message | resend | stop
  "prompt": "继续",              // message 发的消息
  "maxRetries": 10,              // 1–50
  "maxSameError": 10,            // 1–50
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
- 不带 `when` 的兜底只管出错，不管空回复；空回复要单独写一条 `"when": { "empty": true }` 的规则。
- `"action": "stop"` 的规则命中就停、只提醒，也挡住后面的兜底。适合额度用完这类重试没用的错误。
- `enabled: false` 的规则保留但跳过。
- 每条规则有自己的续跑次数；「同一个错误连续几次」不分规则，但用的是当前命中规则的上限。

| 字段                                                      | 说明                                                              |
| :-------------------------------------------------------- | :---------------------------------------------------------------- |
| `name`                                                    | 规则名，出现在通知里，不能重名；不写时按位置叫 `rule-1`、`rule-2` |
| `enabled`                                                 | `false` 时保留但跳过                                              |
| `when.empty`                                              | 写 `true` 时只管空回复，不管出错；不能和 `when.error` 一起写      |
| `when.error`                                              | 正则，大小写不敏感，对原始错误文案匹配                            |
| `when.provider` / `when.model`                            | 通配，只有 `*` 有特殊含义，大小写不敏感，整串匹配                 |
| `action`、`prompt`、`maxRetries`、`maxSameError`、`delay` | 覆盖顶层的同名字段                                                |

`prompt` 里可以写 `{attempt}`（第几次）、`{max}`（最多几次）、`{error}`（错误摘要，空回复时是「空回复」）、`{rule}`（规则名）。

**设置文件里有读不懂的地方，整份不生效**，修好之前不会自动续跑，启动时和 `/onward status` 都会提醒。拼错或不认识的键、超出范围的值、不是 `true` / `false` 的 `enabled`、重名的规则都算。不会只丢掉写坏的那部分、其余照跑：那样错误会落到更宽的规则或默认值上，比如写坏了的 `stop` 规则让额度错误落到兜底去续跑，多发真实请求。问题用 `/onward show` 查看，改完 `/onward reload`。设置文件不是合法 JSON、或者顶层不是对象时也一样；这时命令不会改写它，回复「未做任何修改」。有项目级设置时，两份里任何一份这样，都是整份不生效。

### 项目级设置

在启动 pi 的目录下写 `.pi/onward.json`，写法和上面一样，只写和全局不同的字段。例如这个项目里不续跑，只要写 `{ "enabled": false }`，或者输入 `/onward --scope project off`。

- **只看当前目录**：只读启动 pi 的那个目录下的 `.pi/onward.json`，不往上级目录找，和 pi 读 `.pi/settings.json` 一样。在仓库的子目录里启动 pi，仓库根目录的那份不生效。
- **和全局合并**：优先级是内置默认值 < 全局 < 项目级。开关和顶层的参数逐个字段合并，项目级写了的覆盖全局的，都没写的用内置默认值。`rules` 整份替换、不拼接：项目级写了 `rules` 就只用它的，写成 `[]` 就是这个项目里没有规则；没写才用全局的。规则按顺序第一条命中、不能重名，拼在一起顺序和重名都说不清。
- **命令看或改哪一份由 `--scope` 定**：写在动作前，`/onward --scope project set maxRetries=3`，也可以写成 `--scope=project`。`on`、`off`、`set`、`unset`、`reset` 不写或写 `global` 改全局，和 pi 的 `install`、`config` 不加 `--local` 时一样，写 `project` 改这一份，文件不在就建，去掉本来就没有的参数时不建。`show` 不写时看合并后的结果，写了只看那一份文件写了什么，不合并、不填默认值。其他动作不认它；写在动作后不执行，回复给出正确的写法。只写 `/onward --scope project` 时弹出只看、只改这一份的菜单，`/onward` 的菜单里也有进到每一份的项。改了全局、项目级又写了同名字段时，回复会说这个项目里仍按项目级的走，并给出跟随全局的写法 `/onward --scope project unset <字段>`。
- **看得见在用哪一份**：用上了项目级设置时启动提醒一句，哪一份有问题也说是哪一份；`/onward status` 列出两份文件，`/onward show` 写明每个参数和规则来自哪一份。

**别人的仓库可能自带 `.pi/onward.json`**，和 `AGENTS.md` 一样先看一遍再用：它的 `prompt` 会当成你的消息发给模型，次数和间隔决定多发多少真实请求。在这样的目录里启动 pi 它就生效，和 pi 信不信任这个项目无关。

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
      "name": "empty",
      "when": {
        "empty": true
      },
      "action": "message",
      "maxRetries": 3
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

| 规则               | 管什么                                                                       | 怎么做                                                                                           |
| :----------------- | :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| `quota`            | 额度、余额用完（`insufficient_quota`、`billing`、`usage limit`、`余额不足`） | `stop`：只提醒，不续跑，也不落到后面的兜底                                                       |
| `context-overflow` | 上下文超长                                                                   | `stop`：pi 已经自动压缩并重来过一次，再发一样会超。手动 `/compact` 或换更大上下文的模型          |
| `auth`             | 中转间歇吐出的 `401`、`Invalid API key`                                      | 静默重发，最多 20 次，间隔封顶 10 秒；key 真的错了的话，同一个错误连续超过 10 次就停             |
| `rate-limit`       | pi 自带重试用完后仍然 `429`                                                  | 静默重发，间隔拉长到 30 秒 → 1 分 → 2 分，最多 5 次                                              |
| `server`           | `5xx`、`overloaded`、上游负载饱和                                            | 静默重发，默认间隔                                                                               |
| `network`          | `Connection error.`、`ECONNRESET`、超时、`fetch failed`                      | 静默重发，默认间隔                                                                               |
| `empty`            | 空回复：正常结束，但没有文字也没有工具调用。中转偶尔这样返回                 | 发「继续」让模型接着做；原样重发通常还是空的。最多 3 次                                          |
| `fallback`         | 上面都没命中的错误                                                           | 发一条带错误摘要的消息，让模型自己接着做；最多 3 次，同一个错误连续超过 2 次就停。不想兜底就删掉 |

- 只想对某个中转生效：在 `when` 里加 `"provider": "你的中转-*"`（只有 `*` 是通配）。
- 各家的错误文案不一样。没命中的话，看 pi 显示的错误原文，补进对应规则的 `when.error`。它对原始错误文案匹配，大小写不敏感，JSON 里的反斜杠要写两遍。

## 🧰 命令速查

参数写在动作后，写成 `字段=值`，字段名和设置文件一样；改哪一份设置的 `--scope` 写在动作前。动作、字段、取值和选项都区分大小写，和设置文件、pi 自己的命令名一样：`/onward RESET`、`set maxretries=3`、`delay=5S` 都会被拒绝。

| 命令                             | 作用                                                                                                                                                                             |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/onward`                        | 弹出菜单，标题是现在的状态；选了就执行，`set`、`unset` 填进输入框接着写参数，`--scope <层> …` 进到只看、只改那一份的菜单                                                         |
| `/onward status`                 | 现在会不会续跑、规则没写的参数（做法、上限、间隔）、全局和项目级设置文件；正在续跑时还有进度                                                                                     |
| `/onward on` · `off`             | 开关                                                                                                                                                                             |
| `/onward show`                   | 各项参数的值和来源（全局设置、项目级设置或内置默认值）、规则、设置文件里的问题                                                                                                   |
| `/onward show rules`             | 只看规则                                                                                                                                                                         |
| `/onward set 字段=值 …`          | 改顶层的参数，规则没写的字段用它；例如 `set action=resend maxRetries=20 delay=5s,10s,30s`                                                                                        |
| `/onward unset 字段 …`           | 去掉开关 `enabled` 或参数，继承下一层：项目级的退回全局，全局的退回内置默认值，例如 `unset delay`、`--scope project unset enabled`                                               |
| `/onward reload`                 | 重新读两份设置文件                                                                                                                                                               |
| `/onward reset`                  | 去掉 `enabled` 和顶层的参数，保留手写的 `rules`                                                                                                                                  |
| `/onward --scope project <动作>` | `on`、`off`、`set`、`unset`、`reset` 改项目级设置，不写 `--scope` 或写 `--scope global` 改全局；`show` 只看项目级文件写了什么；只写 `--scope project` 弹出只看、只改项目级的菜单 |
| `/onward --help`                 | 有哪些动作                                                                                                                                                                       |
| `/onward <动作> --help`          | 这个动作的用法和说明；`set --help`、`unset --help` 还列出字段和默认值。写了 `--help` 就只显示帮助，不执行                                                                        |

- `set` 全有或全无：任何一项不合法就一项都不改，问题一起说。
- `--scope` 只能写在动作前：`/onward set maxRetries=3 --scope project` 不执行，回复给出正确的写法。见[项目级设置](#项目级设置)。
- 值里有空格时加双引号：`/onward set prompt="接着做，第 {attempt} 次"`。
- 命令不会新增规则，`set rules=…` 会被拒绝。
- 输入时按 Tab 补全 `--scope` 和它的取值、动作、字段名、`action` 的取值和 `--help`，选中一项再按 Tab 补下一层。`--scope` 只在动作前给，写了它之后只给改设置的动作。每个动作后面都给 `--help`；写了 `--help` 就是结束，什么都不再补。写过的字段不再给，引号里的值不补。

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
npm run gen:schema           # 改了字段、取值或默认值之后，重新生成 onward.schema.json
```

| 目录             | 内容                                                                                                                                                                                                                                                                                                                          |
| :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/policy/`    | 纯逻辑，不碰 pi 的运行时和文件（只用 pi 的类型）：什么算失败（`failure`）、命中哪条规则（`rules`）、按什么参数（`policy`，一张字段表管校验、帮助、补全和 JSON Schema）、等多久（`delay`）、什么时候停（`tracker`）；`config` 把它们拼成设置文件的模型，并把几份设置文件按顺序合并；`schema` 从字段表生成 `onward.schema.json` |
| `src/extension/` | 接 pi：`onward` 处理事件并续跑，`command` 是 `/onward`，`autocomplete` 让它的参数里按 Tab 补参数、不补文件名，`settings` 读写全局和项目级设置文件并合并，`text` 是给人看的文字，`render` 画会话里的续跑消息，`install` 把它们装起来；`index` 是 pi 加载的入口，只决定设置文件放在哪里                                         |
| `tests/`         | `node:test`，目录与 `src/` 对应；`tests/support/fake-pi.ts` 按 pi 的真实事件顺序发事件，直接装 `install`，不加载 pi 本体；补全在 pi-tui 真实的编辑器里按键。入口和设置文件的位置由 `scripts/check-extension.mjs` 用 pi 自己的加载器检查                                                                                       |
