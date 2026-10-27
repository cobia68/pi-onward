/** 假的 pi：只实现扩展用到的 on / registerCommand / getCommands，按真实顺序发事件。 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, type OnwardOptions } from "../../src/extension/index.ts";
import type { Failure } from "../../src/policy/failure.ts";

type Handler = (event: any, ctx: any) => unknown;

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-onward-"));
}

/** 写一份设置文件，返回路径。 */
export function writeConfig(value: unknown, dir = tempDir()): string {
	const path = join(dir, "onward.json");
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}

export const err = (errorMessage = "401 Invalid API key", extra: Partial<Failure> = {}): Failure => ({
	role: "assistant",
	stopReason: "error",
	errorMessage,
	provider: "welfare-100xlabs",
	model: "claude-opus-5-5",
	...extra,
});
export const ok = () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
export const tool = () => ({ role: "assistant", stopReason: "toolUse", content: [] });
export const aborted = () => ({ role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" });

/** 收尾边界事件：最后一条上下文是 `message`。 */
export function boundaryEvent(message: any, id = "e1", extra: Record<string, unknown> = {}) {
	return {
		outcome: message?.stopReason === "aborted" ? "aborted" : message?.stopReason === "error" ? "error" : "completed",
		entries: [],
		continue: false,
		context: {
			contextEntries: [{ sourceEntry: { id, type: "message" }, messages: [message] }],
			contextMessages: [message],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		},
		...extra,
	};
}

export interface Harness {
	emit(event: string, payload?: any): Promise<any>;
	command(text: string): Promise<string>;
	/** message 模式续跑时追加的消息。 */
	sent: string[];
	notes: [string, string][];
	warnings(): string[];
	controller: AbortController;
	configPath: string;
	/** 用户排进来、还没处理的消息数。 */
	pending: number;
	/** 一次助手回复走到收尾边界；要求继续时模拟 pi 重新发 agent_start，否则落定。 */
	boundary(message: any, id?: string): Promise<any>;
}

let sessions = 0;

export function harness(
	options: OnwardOptions & { config?: unknown; commands?: string[]; copies?: number } = {},
): Harness {
	const { config, commands: commandNames = [], copies = 1, ...installOptions } = options;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const notes: [string, string][] = [];
	const controller = new AbortController();
	const sessionId = `session-${++sessions}`;
	let pending = 0;
	const ctx = {
		hasUI: true,
		get signal() {
			return controller.signal;
		},
		hasPendingMessages: () => pending > 0,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string, level: string) => notes.push([level, message]) },
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, opts: any) {
			commands.set(name, opts);
		},
		getCommands() {
			return commandNames.map((name) => ({ name, source: "extension" }));
		},
	};
	const configPath =
		installOptions.configPath ?? (config === undefined ? join(tempDir(), "onward.json") : writeConfig(config));
	for (let i = 0; i < copies; i++) install(pi as any, { legacyPath: false, ...installOptions, configPath });

	// 和 pi 一样：边界上后一个处理器看到前面提出的条目和继续要求。
	const emit = async (event: string, payload: any = {}) => {
		let state = { type: event, ...payload };
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const value: any = await handler(state, ctx);
			if (value === undefined) continue;
			result = value;
			if (event === "agent_before_settle")
				state = { ...state, entries: value.entries ?? state.entries, continue: state.continue || !!value.continue };
		}
		return result;
	};
	const command = async (text: string) => {
		await commands.get("onward").handler(text, ctx);
		return notes.at(-1)?.[1] ?? "";
	};
	return {
		emit,
		command,
		sent,
		notes,
		warnings: () => notes.filter(([level]) => level === "warning").map(([, m]) => m),
		controller,
		configPath,
		get pending() {
			return pending;
		},
		set pending(value: number) {
			pending = value;
		},
		async boundary(message, id = "e1") {
			await emit("message_end", { message });
			const result = await emit("agent_before_settle", boundaryEvent(message, id));
			if (result?.continue) {
				for (const entry of result.entries) if (entry.type === "custom_message") sent.push(entry.content);
				await emit("agent_start");
			} else await emit("agent_settled", { aborted: message?.stopReason === "aborted" });
			return result;
		},
	};
}
