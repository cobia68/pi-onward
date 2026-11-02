<div align="center">

# ⏩ pi-onward

[pi](https://pi.dev) 出错或空回停止时，按规则自动续跑

</div>

pi-onward 是 pi 自带重试与恢复机制的补充。在这些流程结束后，如果仍然报错或空回复，就按你写的规则续跑：发一条「继续」，或者静默重发同一个请求

常见的情况有中转间歇出现的 `401 Invalid API key`，pi 自带重试用完后仍然失败的 `429`、`502`、`Connection error.`，以及中转偶尔返回的空回复

## 📦 安装

```bash
pi install npm:@cobia/pi-onward
```

装好后还没有规则，出错时什么都不做。把包里的 [`example.json`](example.json)（在 `~/.pi/agent/npm/node_modules/@cobia/pi-onward/example.json`）复制成 `~/.pi/agent/onward.json`，已有的话先备份。重开 pi 或输入 `/reload`，再输入 `/onward status`，看到「⏩ onward：开，8 条规则生效」就能用了

## ⚙️ 工作方式

pi 明确报错，或正常结束却没有非空文字、也没有工具调用（空回复），都算失败。pi-onward 只处理这两种失败，从上往下找第一条命中的规则，按它的 `action` 处理；没命中就不管，按 Esc 取消也不处理

| `action` | 做法 |
| :-- | :-- |
| `message`（默认） | 发一条消息（默认「继续」）让模型接着做，会话里看得见这条消息 |
| `resend` | 把失败的那次从模型上下文里去掉，重发同一个请求，不发消息 |
| `stop` | 不续跑，只提醒一次；后面的规则也不再看 |

**上限**（每次续跑都是真实请求）：

- 每条规则连续续跑最多 `maxRetries` 次，默认 10
- 同一个错误连续续跑最多 `maxSameError` 次，默认 10。计数不分规则，按当前命中规则的上限；错误文案里每次都变的部分（如 request id）不算差异
- 两个上限各自生效，先到哪个就停，只提醒一次；只改 `maxRetries` 不会连带改 `maxSameError`
- 续跑后只要正常返回过一次（包括工具轮，不包括空回复），次数就从头算。所以上限管的是连着失败：每次续跑后都有进展，就会一直续下去
- 同一种失败如果也会触发 pi 自带的重试，两层会放大请求量，设置上限时要一起考虑

**间隔** `delay`，每个值都带单位 `ms`、`s` 或 `m`：

- `3s..15s`（默认）：每次多等 3 秒，最多 15 秒，即 3、6、9、12、15、15… 秒
- `30s,1m,2m`：按列表等，用完后一直用最后一个

## 📋 常见规则

下面就是 `example.json` 里的规则。重试没用的错误放在最前面，免得落到后面的规则去续跑；用不到的整条删掉

```json
{
  "rules": [
    {
      "name": "quota",
      "when": {
        "failure": "insufficient[\\s_-]*quota|exceeded your current quota|quota exceeded|out of budget|billing|usage limit|余额不足|额度不足|额度已用尽"
      },
      "action": "stop"
    },
    {
      "name": "context-overflow",
      "when": {
        "failure": "context[\\s_-]*(length|window)|prompt (is )?too long|maximum context|request_too_large"
      },
      "action": "stop"
    },
    {
      "name": "auth",
      "when": {
        "failure": "\\b401\\b|unauthorized|authentication|invalid[\\s_-]*(x-)?(api[\\s_-]*)?(key|token)"
      },
      "action": "resend",
      "maxRetries": 20,
      "maxSameError": 10,
      "delay": "3s..10s"
    },
    {
      "name": "rate-limit",
      "when": {
        "failure": "\\b429\\b|rate[\\s_-]*limit|too many requests|resource[\\s_-]*exhausted"
      },
      "action": "resend",
      "maxRetries": 5,
      "maxSameError": 10,
      "delay": "30s,1m,2m"
    },
    {
      "name": "server",
      "when": {
        "failure": "\\b(500|502|503|504|520|524|529)\\b|overloaded|server[\\s_-]*error|internal[\\s_-]*error|bad gateway|service[\\s_-]*unavailable|upstream|负载已饱和"
      },
      "action": "resend"
    },
    {
      "name": "network",
      "when": {
        "failure": "connection|network|econnreset|econnrefused|etimedout|socket hang up|fetch failed|timed? ?out|terminated"
      },
      "action": "resend"
    },
    {
      "name": "empty",
      "when": {
        "failure": "^$"
      },
      "action": "message",
      "maxRetries": 3,
      "maxSameError": 10
    },
    {
      "name": "fallback",
      "action": "message",
      "prompt": "上一步失败了（{error}），接着做",
      "maxRetries": 3,
      "maxSameError": 2
    }
  ]
}
```

| 规则 | 管什么 | 怎么做 |
| :-- | :-- | :-- |
| `quota` | 额度、余额用完 | `stop`：只提醒，不续跑 |
| `context-overflow` | 上下文超长 | `stop`：先检查自动压缩是否启用、是否成功；必要时手动 `/compact`，或换上下文更大的模型 |
| `auth` | 中转间歇出现的 `401`、`Invalid API key` | 静默重发，最多 20 次，间隔最多 10 秒；同一个错误连续续跑最多 10 次 |
| `rate-limit` | pi 自带重试用完后仍然 `429` | 静默重发，间隔 30 秒、1 分、2 分，最多 5 次 |
| `server` | 部分 `5xx`、`overloaded`、上游负载饱和 | 静默重发 |
| `network` | 连接出错、超时、`fetch failed` | 静默重发 |
| `empty` | 空回复 | 发「继续」，最多 3 次 |
| `fallback` | 上面都没命中的失败，包括空回复 | 发一条带失败摘要的消息让模型接着做，最多 3 次；同一个失败连续续跑最多 2 次。不想兜底就删掉 |

- 只对某个中转生效：在 `when` 里加 `"provider": "你的中转-*"`，只有 `*` 是通配
- 错误没命中时，把 pi 显示的错误原文补进对应规则的 `when.failure`。它是大小写不敏感的正则，JSON 里的反斜杠要写两遍

## 📝 设置文件

全局设置是 `~/.pi/agent/onward.json`，设了 `PI_CODING_AGENT_DIR` 就在那个目录里。`rules` 要手写，改完输入 `/onward reload`；开关和顶层参数也可以用 `/onward` 命令改

顶层的参数是每条规则的默认值，规则里只写和顶层不同的。`//` 注释只为说明，真实文件里不能写：

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cobia68/pi-onward/main/onward.schema.json", // 可选，让编辑器补全字段、检查取值
  "enabled": true,               // 开关
  "action": "message",           // message | resend | stop
  "prompt": "继续",              // message 发的消息
  "maxRetries": 10,              // 1–50
  "maxSameError": 10,            // 1–50
  "delay": "3s..15s",            // 或 "5s,10s,30s"
  "quietStartup": true,          // 启动时不提示（设置有问题照样提醒）；不写时跟着 pi 的，只能写在全局
  "rules": []                    // 写法见下面的「规则」
}
```

设置文件里有读不懂的地方（拼错的键、超出范围的值、写错的正则、重名的规则、兜底没写 `action`），整份不生效，修好之前不会续跑，启动时会提醒。用 `/onward show` 看问题在哪，改完 `/onward reload`

### 规则

| 字段 | 说明 |
| :-- | :-- |
| `name` | 规则名，显示在状态栏和提醒里，不能重名；不写时叫 `rule-1`、`rule-2`… |
| `enabled` | `false` 时保留但跳过 |
| `when.failure` | 非空正则字符串，大小写不敏感，匹配失败文本 |
| `when.provider` / `when.model` | 整串匹配，只有 `*` 是通配，大小写不敏感 |
| `action`、`prompt`、`maxRetries`、`maxSameError`、`delay` | 覆盖顶层的同名参数 |

失败文本：普通错误用原始错误文案，没有有效文案时用「未知错误」；空回复用空字符串。所有 `failure` 都走同一套正则匹配：

| `when.failure` | 匹配范围 |
| :-- | :-- |
| `"^$"` | 空回复 |
| `"401\|unauthorized"` | 对应错误文案 |
| `"401\|^$"` | 401 错误或空回复 |
| `".+"` | 所有普通错误，不含空回复 |
| `".*"` | 所有失败，包括空回复 |

不能写空正则 `""`：它会匹配所有字符串，容易意外变成兜底；匹配空回复写 `^$`，匹配全部写 `.*`

- `when` 里写了几项，要都满足才算命中；不写 `failure` 就不限制失败类型，空回复也在内
- 不带 `when` 或写成 `"when": {}` 时是所有失败的兜底，**必须显式写 `action`**，如 `{ "name": "fallback", "action": "message" }`；其他参数仍可继承
- `prompt` 里可以写 `{attempt}`（第几次）、`{max}`（最多几次）、`{error}`（失败摘要，空回复时为「空回复」）、`{rule}`（规则名）
- 前面的无条件兜底挡住后续失败规则，或规则显式写了当前动作不用的参数（如 `resend` 的 `prompt`、`stop` 的 `delay`），会在启动和 `/onward status` 提醒，细节见 `/onward show`。这些提醒不影响设置生效，也不受 `quietStartup` 影响；停用的规则、继承来的默认参数不参与这些提醒

### 项目级设置

在启动 pi 的目录下写 `.pi/onward.json`，只写和全局不同的字段。例如这个项目里不续跑：写 `{ "enabled": false }`，或者输入 `/onward --scope project off`

- 只读启动目录下的这一份，不往上级目录找：在仓库的子目录里启动 pi，仓库根目录的那份不生效
- 写了 `rules` 就整份替换全局的规则，不合并
- 别人的仓库可能自带 `.pi/onward.json`，先看一遍再用：它的 `prompt` 会当成你的消息发给模型，次数和间隔决定多发多少真实请求

## 🧰 命令速查

| 命令 | 作用 |
| :-- | :-- |
| `/onward` | 弹出菜单 |
| `/onward status` | 现在会不会续跑、默认参数、设置文件在哪 |
| `/onward on` · `off` | 开关 |
| `/onward show` | 各项参数的值和来源、规则、设置文件里的问题 |
| `/onward set 字段=值 …` | 改顶层参数，例如 `/onward set action=resend maxRetries=20` |
| `/onward unset 字段 …` | 去掉开关或参数，退回上一层：项目级的退回全局，全局的退回默认值 |
| `/onward reload` | 重新读设置文件，手改 `rules` 之后用 |
| `/onward reset` | 去掉开关和参数，保留手写的 `rules` |
| `/onward --help` | 用法；`/onward set --help` 还列出字段和默认值 |

- 改项目级设置：把 `--scope project` 写在动作前，例如 `/onward --scope project set maxRetries=3`
- 值里有空格时加双引号：`/onward set prompt="接着做，第 {attempt} 次"`
- 动作、字段和取值都区分大小写；按 Tab 可以补全

## 🧩 Pi 子会话支持

pi-onward 不依赖特定的子代理工具。只要子会话运行在兼容的 Pi 环境中，能加载本扩展并正常执行 Pi 的续跑生命周期，就能按规则处理报错和空回复

父会话加载了 pi-onward，不代表子会话也已加载；子会话自身需要加载扩展和有效的 onward 设置。非 Pi 运行时的子代理不在支持范围内

### 以 pi-subagents 为例

[pi-subagents](https://github.com/nicobailon/pi-subagents) 的本地原生 Pi 子会话可以显式加载 pi-onward。前台子会话不会自动加载父会话的扩展，可以在 `~/.pi/agent/settings.json` 中设置子会话的默认扩展列表，前台、后台都适用：

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": [
      "~/.pi/agent/npm/node_modules/@cobia/pi-onward/src/extension/index.ts"
    ]
  }
}
```

- 这是 pi-subagents 的设置，不要写进 `onward.json`；入口路径按实际安装位置调整，已有列表时追加，不要覆盖其他扩展
- agent 自己设置了 `subagentOnlyExtensions`（包括空列表）时，不使用默认列表；如果还有 `agentOverrides`，以覆盖后的实际列表为准。把入口路径加进最终生效的列表，列表不会自动合并
- 子会话必须允许加载扩展；改完重开 Pi 或输入 `/reload`，再启动新的子会话。加载和覆盖规则见 pi-subagents 的[扩展选择](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md#tool-and-extension-selection)和[默认扩展设置](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md#extension-defaults)
