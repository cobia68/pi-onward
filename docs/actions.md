# 动作提供者协议

普通插件命令使用 `pi.command`，目标插件只需已在 Pi 中注册命令，不需要实现本文的协议。`pi.message` 和 `pi.command` 由 onward 内置的 Pi 适配模块注册，无需额外安装；这两个名称属于 onward 的动作命名空间，并非 Pi 官方 API。本文用于独立桥接扩展或插件主动提供结构化能力。

## 发现与加载

Pi 负责安装、加载和销毁扩展。动作提供者在扩展工厂里监听 `onward:discover-actions`，同步调用事件参数的 `add(definition)`。onward 在 `session_start` 中发起发现；此时所有扩展工厂已完成，因此与加载顺序无关。异步发现结果不会纳入该次注册表，耗时准备工作应由扩展工厂完成后再声明动作。

可从 `@cobia/pi-onward/actions` 导入 `provideAction` 和类型，也可以按同样的结构直接实现事件约定。该导出不依赖全局单例，不能依赖两个包共享模块缓存。插件在没有 onward 时可以继续独立工作。

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { provideAction } from "@cobia/pi-onward/actions";

export default function (pi: ExtensionAPI) {
  provideAction(pi, {
    name: "example.notify",
    description: "通知当前失败已交给人工处理",
    phase: "settled",
    modes: ["tui", "rpc"],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } }
    },
    execute(params, context) {
      if (context.signal.aborted) return { kind: "cancelled", message: "已取消" };
      context.host.ui.notify(String(params.text), "warning");
      return { kind: "completed", message: "通知已显示，本轮停止" };
    }
  });
}
```

名称采用 `namespace.action`，每段为小写字母起首，后续允许小写字母、数字和连字符。重复名称使该名称不可用，不按加载顺序覆盖。注册诊断与配置校验分开：未被启用规则引用的注册失败只警告；引用了缺失、冲突或参数非法的动作才阻断整份配置。`/onward actions` 显示包含动作名称的注册失败原因。

`parameters` 使用同步 JSON Schema 2020-12，由 AJV 严格校验；禁止异步 Schema，不转换参数类型，也不写入默认值。提供者在执行时自行采用可选参数的默认值。`format` 注释不验证，额外限制可以在动作中检查并返回明确失败。

`provideAction` 返回注销函数；session_shutdown 时自动注销。注销后保留的旧执行句柄也会返回取消。独立实现协议时同样要防止旧句柄在卸载后继续操作。

## 调用接口

配置只引用 `{"use":"namespace.action","with":{...}}`。调用前把参数复制，提供者修改参数不会影响已加载配置。

通用执行上下文包含：

| 字段 | 含义 |
| --- | --- |
| `invocationId` | 本次调用唯一 ID，用于提供者去重 |
| `episodeId` | 本次恢复过程 ID |
| `sessionId` | 调用时的会话 ID |
| `rule` | 当前规则名 |
| `failures` | 本次恢复过程中的连续失败次数 |
| `minFailures` | 所选阶段的连续失败次数下限，包含当前失败 |
| `failure` | 只读失败快照：kind、text、provider、model |
| `taskPrompt` | 可选的已接收任务文本快照；用于 `{taskPrompt}`，自动消息保留来源，重载后按会话记录重建 |
| `chain` | 只读恢复链：id、handoffs、maxHandoffs |
| `signal` | 合并取消及动作执行时限的信号 |

`boundary` 动作额外得到 `targetId`，用来生成 `context_edit`，并可以返回 `{kind:"continue",entries:[...]}`。条目由 Pi 验证和提交；在此阶段不能等待当前轮次结束，也不能直接调用需要空闲命令上下文的操作。

`settled` 动作额外得到 `host: ExtensionCommandContext`。执行器通过 Pi 的命令桥接，确保所有 `agent_settled` 观察者结束后再执行。调用前重新检查会话、取消、配置、空闲状态和排队消息。不要把 `host` 保存到另一会话或进程；Pi 重载或替换会话后它会失效。

## 结果和副作用

| kind | 含义 |
| --- | --- |
| `continue` | 边界动作提出下一轮；只有 Pi 真正启动才记已启动续跑 |
| `completed` | 动作自身完成，本轮结束；不自动追加模型请求 |
| `dispatched` | 已提交给另一个系统，业务结果未知；通用命令返回此结果 |
| `handoff` | 提供者接受后续恢复责任，需要声明 `handoff:true` |
| `stopped` | 策略要求停止 |
| `failed` | 提供者明确报告未成功执行 |
| `cancelled` | 明确取消 |
| `unknown` | 可能已产生副作用，最终结果未知 |

失败、停止、取消和未知必须带 `message`；其他结果可选。意外异常、超时及非法返回均转为 `unknown`，不自动重放、不自动进入下一阶段。提供者应在副作用前检查 `signal` 并把它传给可取消操作。超时不能强行终止进程内 JavaScript，也不能撤销已发生的副作用。

落定动作执行前会写入 `onward.action` 自定义记录，结束后写入结果。记录不包含提示词或失败原文，也不进入模型上下文。重载不重放记录。当前运行时对一次调用最多分派一次，跨崩溃的去重仍由提供者使用 invocationId 处理。

## 可选的跨会话接管

仅有跨会话责任的原生动作声明 `handoff:true`。调用前执行器预留一次预算，传给提供者的 `chain.handoffs` 已包含本次。明确 failed/cancelled/stopped/completed 会退回预留；unknown 保留。新会话的限制只允许维持或收紧链的上限。

提供者负责把 `chain` 存进自己的一次性、可验证、可过期的交接记录。校验新会话来源并成功认领记录后，在发送自动提示之前发出：

```ts
pi.events.emit("onward:resume-recovery", {
  sessionId: ctx.sessionManager.getSessionId(),
  chain: savedChain
});
```

onward 在工厂初始化时已监听此事件，支持在它自己的 session_start 之前或之后收到。错误的会话 ID 不生效。已接收的人工新任务或正常模型进展结束恢复链；自动注入的消息保留当前链。

通用 slash 命令没有上述约定，也没有业务结果回执，因此不能推断恢复链已传递。跨会话或跨进程的防循环由目标扩展负责。独立桥接扩展也不能通过包装命令声称获得了命令没有公开的确认、取消或去重能力。
