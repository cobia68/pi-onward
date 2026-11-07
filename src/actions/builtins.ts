/** Built-ins implement exactly the same contract as external actions. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piActions } from "./pi.ts";
import type { ActionDefinition } from "./protocol.ts";

const modes = ["tui", "rpc", "json", "print"] as const;
export function builtinActions(pi: Pick<ExtensionAPI, "getCommands" | "sendUserMessage">): ActionDefinition[] {
	return [
		...piActions(pi),
		{
			name: "onward.stop",
			description: "停止本次自动恢复",
			phase: "boundary",
			modes,
			parameters: {
				type: "object",
				properties: { reason: { type: "string", pattern: "\\S" } },
				additionalProperties: false,
			},
			execute(params) {
				return { kind: "stopped", message: String(params.reason ?? "规则要求停止，请处理失败原因后再发消息") };
			},
		},
	];
}
