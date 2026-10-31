/** 假的 pi：只实现扩展用到的 on / registerCommand / ctx.ui，按真实顺序发事件。 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { install } from "../../src/extension/install.ts";
import type { ConfigPaths } from "../../src/extension/settings.ts";
import type { AgentMessage, EmptyReply, Failure } from "../../src/policy/failure.ts";

type Handler = (event: any, ctx: any) => unknown;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-onward-"));
}

/** 写一份设置文件，返回路径；目录不在就建。 */
export function writeConfig(value: unknown, path = join(tempDir(), "onward.json")): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}

/** 和 index.ts 一样：项目级是当前目录下的 .pi/onward.json。 */
export const projectConfigPath = (cwd: string) => join(cwd, ".pi", "onward.json");

/** 只给全局的路径时，项目级按 index.ts 的规矩放。 */
export const paths = (file: string): ConfigPaths => ({ global: file, project: projectConfigPath });

/** 一条字段齐全的助手消息，和 pi 发来的一样。 */
export const assistant = (extra: Partial<Assistant> = {}): Assistant => ({
	role: "assistant",
	content: [],
	api: "anthropic-messages",
	provider: "welfare-100xlabs",
	model: "claude-opus-5-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
	...extra,
});

export const err = (errorMessage = "401 Invalid API key", extra: Partial<Assistant> = {}): Failure =>
	assistant({ errorMessage, ...extra, stopReason: "error" }) as Failure;
export const ok = () => assistant({ content: [{ type: "text", text: "done" }] });
/** 正常结束但什么都没生成：中转偶尔会这样返回。 */
export const empty = (extra: Partial<Assistant> = {}): EmptyReply =>
	assistant({ content: [], ...extra, stopReason: "stop" }) as EmptyReply;
export const tool = () => assistant({ stopReason: "toolUse" });
export const aborted = () => assistant({ stopReason: "aborted", errorMessage: "Operation aborted" });

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
	/** 全局设置文件。 */
	configPath: string;
	/** 当前目录和它的项目级设置文件；项目级等 session_start 才读。 */
	cwd: string;
	projectPath: string;
	/** 用户排进来、还没处理的消息数。 */
	pending: number;
	/** 一次助手回复走到收尾边界；要求继续时模拟 pi 重新发 agent_start，否则落定。 */
	boundary(message: any, id?: string): Promise<any>;
	/** 状态栏里 pi-onward 那一格；写过几次。 */
	status(): string | undefined;
	statusWrites: number;
	/** 用 ctx.ui.addAutocompleteProvider 装上的补全。 */
	autocomplete: unknown[];
	/** ctx.ui.select 弹过的菜单；`pick` 决定选哪一项，默认取消。 */
	menus: { title: string; options: string[] }[];
	pick: (options: string[]) => string | undefined;
	/** ctx.ui.setEditorText 最后填的字。 */
	editorText: string | undefined;
	/** pi.registerMessageRenderer 注册的渲染器。 */
	renderers: Map<string, unknown>;
}

let sessions = 0;

/** `config` 是全局设置的内容，`project` 是当前目录下 .pi/onward.json 的内容；字符串原样写进去。 */
export function harness(
	options: {
		configPath?: string;
		config?: unknown;
		project?: unknown;
		cwd?: string;
		copies?: number;
		ui?: boolean;
	} = {},
): Harness {
	const { config, project, copies = 1, ui = true } = options;
	const statuses = new Map<string, string>();
	let statusWrites = 0;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const notes: [string, string][] = [];
	const autocomplete: unknown[] = [];
	const menus: { title: string; options: string[] }[] = [];
	const renderers = new Map<string, unknown>();
	let pick: (options: string[]) => string | undefined = () => undefined;
	let editorText: string | undefined;
	const controller = new AbortController();
	const sessionId = `session-${++sessions}`;
	let pending = 0;
	const cwd = options.cwd ?? tempDir();
	const projectPath = projectConfigPath(cwd);
	if (project !== undefined) writeConfig(project, projectPath);
	const ctx = {
		hasUI: ui,
		cwd,
		get signal() {
			return controller.signal;
		},
		hasPendingMessages: () => pending > 0,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (message: string, level: string) => notes.push([level, message]),
			setStatus: (key: string, text: string | undefined) => {
				statusWrites++;
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			addAutocompleteProvider: (factory: unknown) => autocomplete.push(factory),
			select: async (title: string, options: string[]) => {
				menus.push({ title, options });
				return pick(options);
			},
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, opts: any) {
			commands.set(name, opts);
		},
		registerMessageRenderer(customType: string, renderer: unknown) {
			renderers.set(customType, renderer);
		},
	};
	const configPath =
		options.configPath ?? (config === undefined ? join(tempDir(), "onward.json") : writeConfig(config));
	for (let i = 0; i < copies; i++) install(pi as any, paths(configPath));

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
		cwd,
		projectPath,
		get pending() {
			return pending;
		},
		status: () => statuses.get("pi-onward"),
		get statusWrites() {
			return statusWrites;
		},
		autocomplete,
		menus,
		renderers,
		get pick() {
			return pick;
		},
		set pick(value) {
			pick = value;
		},
		get editorText() {
			return editorText;
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
