/** Pi message and command adapters, registered through the same interface as external actions. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActionDefinition } from "./protocol.ts";

export const CUSTOM_TYPE = "pi-onward";
const modes = ["tui", "rpc", "json", "print"] as const;
export function piActions(pi: Pick<ExtensionAPI, "getCommands" | "sendUserMessage">): ActionDefinition[] {
	return [
		{
			name: "pi.message",
			description: "发送一条消息续跑",
			phase: "boundary",
			modes,
			parameters: {
				type: "object",
				properties: { prompt: { type: "string", pattern: "\\S", maxLength: 4000, default: "继续" } },
				additionalProperties: false,
			},
			execute(params, context) {
				const prompt = String(params.prompt ?? "继续");
				if (prompt.includes("{taskPrompt}") && !context.taskPrompt?.trim())
					return { kind: "failed", message: "No task prompt is available to expand {taskPrompt}" };
				const vars: Record<string, string> = {
					failures: String(context.failures),
					rule: context.rule,
					error: context.failure.text || "空回复",
					taskPrompt: context.taskPrompt ?? "",
				};
				const content = prompt.replace(/\{(failures|rule|error|taskPrompt)\}/g, (_, key: string) => vars[key]!);
				return {
					kind: "continue",
					entries: [
						{
							type: "custom_message",
							customType: CUSTOM_TYPE,
							content,
							display: true,
							details: { rule: context.rule, failures: context.failures, invocationId: context.invocationId },
						},
					],
				};
			},
		},
		{
			name: "pi.command",
			description: "分派已加载的扩展命令；业务结果未知",
			phase: "settled",
			modes,
			parameters: {
				type: "object",
				required: ["name"],
				additionalProperties: false,
				properties: { name: { type: "string", pattern: "^[^/\\s]+$" }, args: { type: "string" } },
			},
			execute(params, context) {
				if (context.signal.aborted) return { kind: "cancelled", message: "命令分派已取消" };
				const name = String(params.name);
				if (name === "onward" || name.startsWith("onward:"))
					return { kind: "failed", message: "Cannot automatically invoke onward's own control commands" };
				if (!pi.getCommands().some((command) => command.source === "extension" && command.name === name))
					return {
						kind: "failed",
						message: `Extension command /${name} is not loaded; no text was sent to the model`,
					};
				pi.sendUserMessage(`/${name}${params.args ? ` ${params.args}` : ""}`, { expandPromptTemplates: true });
				return { kind: "dispatched", message: `已分派 /${name}；完成情况由目标插件报告` };
			},
		},
	];
}
