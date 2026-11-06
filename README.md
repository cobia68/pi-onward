<div align="center">

# ⏩ pi-onward

[pi](https://pi.dev) 出错或空回复时，按阶段策略自动恢复，也可以调用其他插件提供的动作

</div>

pi-onward 只处理两类失败：Pi 明确以错误结束，或者正常结束但没有文字、工具调用。规则先匹配失败，再根据连续失败次数选择恢复阶段。每个阶段引用一个具名动作；内置重发、发消息、停止、调用扩展命令，以及其他插件提供的结构化能力，都走同一套动作接口。

## 安装

```bash
pi install npm:@cobia/pi-onward
```

pi-onward 本身没有默认规则。复制包里的 [`example.json`](example.json) 到 `~/.pi/agent/onward.json`，重启 Pi 或输入 `/reload`。

调用其他扩展的命令时，目标命令必须已经由 Pi 注册。**目标扩展无需修改、无需注册 onward 动作**。

插件加载由 Pi 管理。`onward.json` 只引用动作名称，不负责加载 npm 包或动态执行任意文件。

## 核心模型

一条规则由匹配条件和 `stages` 组成。阶段的 `minFailures` 是连续失败次数下限，包含当前失败；每次失败选择已经达到下限的最后一个阶段。

```json
{
  "maxFailures": 20,
  "maxHandoffs": 3,
  "actionTimeout": "30s",
  "rules": [
    {
      "name": "server",
      "when": { "failure": "502|503|Connection error" },
      "stages": [
        {
          "minFailures": 1,
          "delay": "3s",
          "action": { "use": "onward.resend" }
        },
        {
          "minFailures": 3,
          "action": {
            "use": "onward.command",
            "with": {
              "name": "example-command",
              "args": "-- 继续执行当前任务"
            }
          }
        }
      ]
    }
  ]
}
```

这条规则的行为是：第 1、2 次失败重发，第 3 次失败后在当前轮次落定，再调用扩展命令。`example-command` 是占位名称，需要替换成实际已加载的命令，`args` 按目标命令的参数格式填写。第一阶段的 `minFailures` 必须是 1，之后严格递增。旧字段 `fromFailure` 已移除，需要改为 `minFailures`。

`onward.command` 确认目标是已加载的扩展命令，再通过 Pi 分派。`args` 原样传给命令，不经过 shell、不替换 onward 模板，也不需要模型来执行。`/model` 等 Pi 内置交互命令不属于扩展命令，不支持这个入口。

结果只能保证“已分派”，不能保证目标插件的业务操作已成功，也不能强制取消已经进入命令处理器的操作。需要结构化结果或恢复链传递时，可以加载提供动作的独立桥接扩展，或让插件选择实现动作协议：

```json
{
  "minFailures": 3,
  "action": {
    "use": "my-plugin.recover",
    "with": { "prompt": "继续执行当前任务" }
  }
}
```

`my-plugin.recover` 是扩展接口示例，需要实际提供者注册后才能使用。动作注册是可选能力，普通插件命令调用不要求目标插件主动适配。

## 内置动作

| 动作 | 阶段 | 作用 |
| --- | --- | --- |
| `onward.resend` | `boundary` | 从模型上下文省略失败回复，重发请求 |
| `onward.message` | `boundary` | 追加一条自定义消息并继续；`prompt` 支持 `{failures}`、`{rule}`、`{error}`、`{taskPrompt}` |
| `onward.stop` | `boundary` | 停止当前恢复过程 |
| `onward.command` | `settled` | 在当前轮次落定后调用已加载的扩展命令 |

`prompt` 默认是 `继续`，所有变量都使用 `{变量名}`，可以与正文拼接。`{taskPrompt}` 替换为本轮任务的提示词文本，例如：

```json
{
  "use": "onward.message",
  "with": { "prompt": "请重新尝试：\n{taskPrompt}" }
}
```

上次输入为 `检查并修复登录接口` 时，会追加 `请重新尝试：` 换行后接该输入。`"prompt": "{taskPrompt}"` 只发送原提示词，`"prompt": "继续{taskPrompt}"` 则在前面加上“继续”。这会追加新消息；独立的 `onward.resend` 仍表示省略失败回复后静默重发请求。

人工或 RPC 新输入会更新 `{taskPrompt}` 的来源，记录的是输入事件中的文本（Pi 技能和提示词模板展开前）。自动续跑不覆盖来源；新会话首次由扩展发起任务时，以该输入为来源。恢复会话或切换分支时，从当前分支最近的用户消息中提取文本，跳过 onward 的自定义续跑消息。仅复用文字，不复制图片附件或整个请求上下文。没有可复用的任务文本时，使用 `{taskPrompt}` 的动作会明确失败并停止本次恢复。

模板只替换一次：原提示词或错误信息中包含的 `{error}`、`{taskPrompt}` 等文字保持原样。未知变量保持原文。

每个阶段只执行一个动作，没有隐式 fallback。动作完成但没有安排新请求时，本轮就停止。`delay` 默认为 `0s`；`3s..15s` 在该阶段内依次等待 3、6、9、12、15、15… 秒，`5s,10s,30s` 用完列表后重复最后一个间隔。终止阶段会保留动作结果，等待新的人工任务。

查看当前运行时实际加载的动作：

```text
/onward actions
```

动作参数由动作提供者自己的 JSON Schema 校验。已启用规则引用的动作名称未加载或参数不符合 Schema 时，整份配置不会进入可运行状态。未被引用的动作注册失败只报告警告，不影响当前规则；`/onward actions` 会列出动作名称和注册失败原因，静默启动也不隐藏注册问题。运行模式在动作调用前检查。通用命令动作无法推断目标命令支持哪些模式，由目标扩展报告限制。

## 可选的动作提供者接口

独立桥接扩展或插件可以在工厂里注册具名动作。注册是为了暴露新的结构化能力，与 Pi 已注册的 slash 命令独立。桥接扩展只能使用目标公开的接口；如果目标只有 slash 命令，桥接也只能得到“已分派”，无法凭空获得业务结果。

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { provideAction } from "@cobia/pi-onward/actions";

export default function (pi: ExtensionAPI) {
  provideAction(pi, {
    name: "my-plugin.recover",
    description: "执行插件自己的恢复流程",
    phase: "settled",
    modes: ["tui"],
    handoff: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { prompt: { type: "string" } }
    },
    async execute(params, context) {
      if (context.signal.aborted) return { kind: "cancelled", message: "已取消" };
      // context.host 是 Pi 在 agent_settled 之后提供的新命令上下文。
      return { kind: "completed", message: "恢复已完成" };
    }
  });
}
```

协议入口是包的 `./actions` 导出；也可以在独立桥接扩展里按 [`动作协议`](docs/actions.md) 直接实现 `pi.events` 事件约定，从而不依赖 onward 的运行时包。提供者与 onward 通过事件进行同步发现，执行时直接调用函数，取得独立调用 ID、恢复过程 ID、失败快照、失败次数、取消信号和恢复链信息。

动作有两种执行阶段：

- `boundary`：在 `agent_before_settle` 中返回下一轮提议，适合 `resend` 和 `message`。
- `settled`：等 Pi 完全落定后执行，适合命令、会话切换、重启和外部副作用。

动作结果分为继续、完成、已分派、已接管、停止、失败、取消和未知。动作超时、抛出异常或返回非法结果时，结果标记为未知，不会自动重放可能已经产生副作用的动作。

## 上限与恢复链

顶层限制是恢复过程级别的：

- `maxFailures`：一次恢复过程允许处理的连续失败数，默认 20。
- `maxHandoffs`：恢复链最多跨 session 接管的次数，默认 3；0 表示禁止接管。
- `actionTimeout`：单次动作执行时限，默认 30 秒。等待 `delay` 不计入动作时限。

正常模型回复一次（包括工具轮）会结束恢复过程。人工新任务、Esc、关闭、重载、切换分支和配置修改会取消未执行动作；其中 Esc 保留本次失败的诊断状态。扩展自动发送的续跑消息不会清空当前恢复过程。这里的一次失败是 `agent_before_settle` 看到的最终结果，不包含 Pi 内建重试期间的每个 HTTP 请求。

带 `handoff: true` 的动作在调用前预留一次接管预算。明确失败、取消或只完成预览时退回预算；超时或异常结果未知时保留。动作提供者必须通过自己的持久交接保存恢复链，并在目标会话启动时恢复，详见[动作协议](docs/actions.md)。

通用命令没有这个结构化约定，onward 的 `maxHandoffs` 不限制普通命令，也不能推断恢复链已传递。跨会话或跨进程的防循环由目标扩展负责。

## 配置

全局配置是 `~/.pi/agent/onward.json`，设置 `PI_CODING_AGENT_DIR` 时跟随 Pi。项目级配置是启动目录下的 `.pi/onward.json`，项目级 `rules` 会整份替换全局规则。

项目配置只在 **Pi 已信任当前项目** 时读写。未受信任时不读取文件内容、不参与合并，也不允许 `/onward --scope project` 修改；全局配置照常生效，`show` 会说明项目层已跳过。确认项目可信后，可用 Pi 的 `--approve` 为本次启动授权，或用 `/trust` 保存决定并重启。仅有 `onward.json` 不一定触发 Pi 的自动信任提示。

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cobia68/pi-onward/main/onward.schema.json",
  "enabled": true,
  "maxFailures": 20,
  "maxHandoffs": 3,
  "actionTimeout": "30s",
  "quietStartup": true,
  "rules": []
}
```

规则的 `when.failure` 是大小写不敏感的正则；空回复是空字符串，因此 `^$` 只匹配空回复，`.+` 只匹配普通错误，`.*` 匹配所有失败。`provider` 和 `model` 是整串匹配，只有 `*` 是通配符。第一条命中规则决定本次动作，换规则或换错误不清零连续失败次数；没命中时停止本次恢复。

### 命令

| 命令 | 行为 |
| --- | --- |
| `/onward` | 查看状态菜单，默认修改全局配置 |
| `/onward status` | 当前阶段、失败数、已启动续跑数及动作结果 |
| `/onward show [rules]` | 已加载配置、来源、规则和文件位置；`rules` 只列规则 |
| `/onward actions` | 当前已加载的具名动作 |
| `/onward on`、`/onward off` | 写入开关，取消当前恢复过程，不立即请求模型 |
| `/onward set 字段=值 …` | 修改上限或全局 quietStartup，全部参数先校验 |
| `/onward unset 字段 …` | 删除指定配置项，采用下层值或默认值 |
| `/onward reload` | 重读配置并取消当前恢复；加载插件使用 Pi 的 `/reload` |
| `/onward reset` | 删除开关、顶层上限和 quietStartup，保留规则；重置运行状态 |

`--scope global|project` 写在动作前，例如 `/onward --scope project off`。不指定范围的修改写全局；`show` 不指定范围则显示合并结果。查询只读，不重载、不清零。所有成功的配置修改（包括只保存在内存的修改）会取消当前恢复。文件不可读时不改文件。

写入失败时，本次运行保留该层的字段修改，`show` 标记“未保存”；修改另一层不会丢掉它们。再次修改同一层时，会先重读文件，合并尚未保存的设置和删除操作，再一起尝试落盘，保留未涉及字段的手工编辑。显式重载、切换会话或重启会清除未保存修改，重新以磁盘内容为准。

`quietStartup` 只能写在全局；未配置时跟随 Pi，配置错误和规则遮挡提醒仍显示。项目配置只读启动目录下这一份，不向上查找；项目 rules 为 `[]` 表示禁用继承规则。

设置文件有未知键、非法正则、空阶段、阶段阈值错误、重复规则或动作不存在时，整份配置不生效。用下面的命令查看问题和已加载动作：

```text
/onward status
/onward show
/onward show rules
/onward actions
/onward reload
```

`/onward set` 只能修改顶层恢复限制，规则和动作写在 JSON 中：

```text
/onward set maxFailures=10 actionTimeout=45s
/onward unset maxHandoffs
/onward --scope project set maxFailures=5
```

## 开发

```bash
npm install --no-bin-links
npm run check
```

`npm run check` 包含 Biome、TypeScript、策略与生命周期测试，以及真实 Pi 扩展加载检查。

单独运行扩展加载检查：

```bash
npm run check:extension
```

扩展动作属于进程内协议，插件的 npm 包仍由 Pi 安装和加载。只加载你信任的扩展。

测试使用隔离配置和本地注册的测试命令、动作，不依赖其他扩展，不读取真实凭据，也不调用外部模型。
