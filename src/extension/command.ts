/** `/onward`：解析参数，改设置或查看状态。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseDuration } from "../policy/delay.ts";
import { type PolicyPatch, parsePolicyPatch } from "../policy/policy.ts";
import { errorText } from "../util.ts";
import type { Onward } from "./onward.ts";
import type { Settings } from "./settings.ts";
import {
	COMMAND,
	commandErrorNotice,
	DESCRIPTION,
	helpNotice,
	type Notice,
	resetFailedNotice,
	resetNotice,
	rulesNotice,
	saveFailedNotice,
	say,
	statusNotice,
} from "./text.ts";

export type Command =
	| { kind: "status" | "help" | "rules" | "reload" | "reset" }
	| { kind: "set"; enabled?: boolean; patch: PolicyPatch }
	| { kind: "error"; message: string };

export function registerCommand(pi: ExtensionAPI, settings: Settings, onward: Onward): void {
	pi.registerCommand(COMMAND, {
		description: DESCRIPTION,
		handler: async (args, ctx) => {
			const notice = execute(parseCommand(args), settings, onward);
			// 不管是命令关的还是 reload 读到手改的关，关了就不该还有等着的续跑。
			if (!settings.config.enabled) onward.stop();
			say(ctx, notice);
		},
	});
}

function execute(command: Command, settings: Settings, onward: Onward): Notice {
	switch (command.kind) {
		case "status":
			return statusNotice(settings, onward.progress());
		case "help":
			return helpNotice();
		case "error":
			return commandErrorNotice(command.message);
		case "rules":
			return rulesNotice(settings.config);
		case "reload":
			settings.reload();
			return statusNotice(settings, onward.progress());
		case "reset":
			onward.stop();
			try {
				return resetNotice(settings, settings.reset());
			} catch (error: unknown) {
				return resetFailedNotice(errorText(error));
			}
		case "set": {
			let failure: string | undefined;
			try {
				settings.update({ enabled: command.enabled, patch: command.patch });
			} catch (error: unknown) {
				failure = errorText(error);
			}
			return failure === undefined
				? statusNotice(settings, onward.progress())
				: saveFailedNotice(failure, settings, onward.progress());
		}
	}
}

/** 范围与校验交给 parsePolicyPatch，和设置文件走同一套规则。 */
export function parseCommand(text: string): Command {
	const trimmed = text.trim();
	const word = trimmed.toLowerCase();
	if (!word || word === "status") return { kind: "status" };
	if (word === "help" || word === "--help" || word === "-h") return { kind: "help" };
	if (word === "rules" || word === "reload" || word === "reset") return { kind: word };
	// prompt= 吃掉整行剩下的部分，里面可以有空格和逗号。
	if (word.startsWith("prompt=")) {
		const prompt = trimmed.slice("prompt=".length).trim();
		return prompt
			? set(undefined, parsePolicyPatch({ prompt }, ""))
			: { kind: "error", message: "prompt= 后面要写内容" };
	}
	let enabled: boolean | undefined;
	const raw: Record<string, unknown> = {};
	const delays: number[] = [];
	for (const token of trimmed.split(/[\s,/]+/).filter(Boolean)) {
		const t = token.toLowerCase();
		const [key, value = ""] = t.split("=", 2);
		if (t === "on" || t === "off") enabled = t === "on";
		else if (t === "message" || t === "silent") raw.mode = t;
		else if (t === "ramp") raw.retryDelaysMs = [];
		else if (/^\d+$/.test(t)) raw.maxRetries = Number(t);
		else if (key === "same" && /^\d+$/.test(value)) raw.sameErrorLimit = Number(value);
		else if (key === "base" || key === "cap") {
			const ms = parseDuration(value);
			if (ms === undefined) return { kind: "error", message: `看不懂的间隔：${token}` };
			raw[key === "base" ? "retryBaseMs" : "retryCapMs"] = ms;
		} else if (/^\d+(?:\.\d+)?(?:ms|s|m)$/.test(t)) delays.push(parseDuration(t)!);
		else return { kind: "error", message: `看不懂的设置：${token}` };
	}
	if (delays.length) raw.retryDelaysMs = delays;
	return set(enabled, parsePolicyPatch(raw, ""));
}

function set(enabled: boolean | undefined, patch: PolicyPatch): Command {
	return enabled === undefined ? { kind: "set", patch } : { kind: "set", enabled, patch };
}
