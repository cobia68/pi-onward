/** Lifecycle fixture: settled commands are deferred until every settled observer has finished. No model calls. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActionDefinition } from "../../src/actions/protocol.ts";
import { provideAction } from "../../src/actions/protocol.ts";
import { install } from "../../src/extension/install.ts";
import type { AgentMessage, EmptyReply, Failure } from "../../src/policy/failure.ts";

type Handler = (event: any, ctx: any) => unknown;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;
export const tempDir = () => mkdtempSync(join(tmpdir(), "pi-onward-test-"));
export function writeConfig(value: unknown, path = join(tempDir(), "onward.json")): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}
export const projectConfigPath = (cwd: string) => join(cwd, ".pi/onward.json");
export const paths = (global: string) => ({ global, project: projectConfigPath });
export const assistant = (extra: Partial<Assistant> = {}): Assistant => ({
	role: "assistant",
	content: [],
	api: "anthropic-messages",
	provider: "test-provider",
	model: "test-model",
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
export const err = (errorMessage = "502 Bad Gateway", extra: Partial<Assistant> = {}): Failure =>
	assistant({ errorMessage, ...extra, stopReason: "error" }) as Failure;
export const empty = (extra: Partial<Assistant> = {}): EmptyReply =>
	assistant({ ...extra, stopReason: "stop" }) as EmptyReply;
export const ok = () => assistant({ content: [{ type: "text", text: "done" }] });
export const tool = () => assistant({ stopReason: "toolUse" });
export const aborted = () => assistant({ stopReason: "aborted", errorMessage: "Operation aborted" });
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
export function stage(minFailures = 1, use = "onward.resend", params?: Record<string, unknown>, delay = "0s") {
	return { minFailures, delay, action: { use, ...(params && { with: params }) } };
}
export function rule(stages = [stage()], name = "server") {
	return { name, stages };
}

let serial = 0;
export function harness(
	options: {
		config?: unknown;
		configPath?: string;
		project?: unknown;
		cwd?: string;
		trusted?: boolean;
		ui?: boolean;
		mode?: "tui" | "rpc" | "print" | "json";
		piSettings?: Record<string, unknown>;
		actions?: ActionDefinition[];
		providerFirst?: boolean;
		copies?: number;
	} = {},
) {
	const cwd = options.cwd ?? tempDir();
	const configPath = options.configPath ?? writeConfig(options.config ?? { rules: [rule()] });
	const projectPath = projectConfigPath(cwd);
	if (options.project !== undefined) writeConfig(options.project, projectPath);
	const sessionId = `test-session-${++serial}`;
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Set<(event: unknown) => void>>();
	const commands = new Map<string, any>();
	const statuses = new Map<string, string>();
	const notes: [string, string][] = [];
	const sent: string[] = [],
		dispatches: string[] = [],
		trace: string[] = [];
	const entries: any[] = [];
	const autocomplete: unknown[] = [],
		menus: { title: string; options: string[] }[] = [];
	const renderers = new Map<string, unknown>();
	const controller = new AbortController();
	let pending = 0,
		busy = false,
		settling = false,
		counter = 0,
		statusWrites = 0;
	let pick: (options: string[]) => string | undefined = () => undefined;
	let editorText: string | undefined;
	const deferred: (() => Promise<unknown>)[] = [];
	const jobs: Promise<unknown>[] = [];
	let projectTrusted = options.trusted ?? true;
	const ctx = {
		cwd,
		isProjectTrusted: () => projectTrusted,
		mode: options.mode ?? "tui",
		hasUI: options.ui ?? true,
		signal: controller.signal,
		hasPendingMessages: () => pending > 0,
		isIdle: () => !busy,
		abort: async () => controller.abort(),
		waitForIdle: async () => {},
		shutdown: () => trace.push("shutdown"),
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafId: () => entries.at(-1)?.id,
		},
		ui: {
			notify: (message: string, level: string) => notes.push([level, message]),
			setStatus: (key: string, text?: string) => {
				statusWrites++;
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			addAutocompleteProvider: (provider: unknown) => autocomplete.push(provider),
			select: async (title: string, values: string[]) => {
				menus.push({ title, options: values });
				return pick(values);
			},
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	};
	const entryPath = fileURLToPath(new URL("../../src/extension/index.ts", import.meta.url));
	const invoke = async (text: string, expand = false) => {
		if (expand && text.startsWith("/")) {
			const [name, ...args] = text.slice(1).split(" ");
			const command = commands.get(name!);
			if (command) {
				trace.push(`command:${name}`);
				await command.handler(args.join(" "), ctx);
				return;
			}
		}
		sent.push(text);
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {
				handlers.set(
					event,
					(handlers.get(event) ?? []).filter((item) => item !== handler),
				);
			};
		},
		events: {
			on(event: string, handler: (event: unknown) => void) {
				if (!listeners.has(event)) listeners.set(event, new Set());
				listeners.get(event)!.add(handler);
				return () => {
					listeners.get(event)?.delete(handler);
				};
			},
			emit(event: string, value: unknown) {
				for (const handler of [...(listeners.get(event) ?? [])]) handler(value);
			},
		},
		registerCommand(name: string, options: any) {
			if (!commands.has(name)) commands.set(name, options);
		},
		registerMessageRenderer(name: string, renderer: unknown) {
			renderers.set(name, renderer);
		},
		getSettings: () => structuredClone(options.piSettings ?? {}),
		getCommands: () =>
			[...commands.keys()].map((name) => ({
				name,
				source: "extension",
				sourceInfo: {
					path: name === "onward" ? entryPath : `/test/${name}.ts`,
					source: "test",
					scope: "temporary",
					origin: "top-level",
				},
			})),
		appendEntry(customType: string, data: unknown) {
			entries.push({ id: `custom-${entries.length}`, type: "custom", customType, data });
		},
		sendUserMessage(text: string, options?: { expandPromptTemplates?: boolean }) {
			dispatches.push(text);
			const run = () => invoke(text, options?.expandPromptTemplates);
			if (settling) deferred.push(run);
			else jobs.push(run());
		},
	};
	const api = pi as unknown as ExtensionAPI;
	const providers = () => {
		for (const action of options.actions ?? []) provideAction(api, action);
	};
	if (options.providerFirst) providers();
	for (let index = 0; index < (options.copies ?? 1); index++) install(api, paths(configPath));
	if (!options.providerFirst) providers();
	async function flush() {
		while (deferred.length || jobs.length) {
			while (deferred.length) await deferred.shift()!();
			await Promise.all(jobs.splice(0));
		}
	}
	async function emit(event: string, payload: any = {}) {
		if (event === "agent_start") busy = true;
		if (event === "agent_settled") {
			busy = false;
			settling = true;
		}
		let state = { type: event, ...payload };
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const value: any = await handler(state, ctx);
			if (value === undefined) continue;
			result = value;
			if (event === "agent_before_settle")
				state = { ...state, entries: value.entries ?? state.entries, continue: value.continue ?? state.continue };
		}
		if (event === "agent_settled") {
			settling = false;
			await flush();
		}
		return result;
	}
	return {
		pi: api,
		ctx,
		emit,
		flush,
		controller,
		configPath,
		cwd,
		projectPath,
		notes,
		sent,
		dispatches,
		trace,
		entries,
		renderers,
		autocomplete,
		menus,
		get pick() {
			return pick;
		},
		set pick(value: typeof pick) {
			pick = value;
		},
		get editorText() {
			return editorText;
		},
		get trusted() {
			return projectTrusted;
		},
		set trusted(value: boolean) {
			projectTrusted = value;
		},
		get pending() {
			return pending;
		},
		set pending(value: number) {
			pending = value;
		},
		get statusWrites() {
			return statusWrites;
		},
		status: () => statuses.get("pi-onward"),
		warnings: () => notes.filter(([level]) => level === "warning").map(([, text]) => text),
		async command(text: string) {
			await commands.get("onward").handler(text, ctx);
			return notes.at(-1)?.[1] ?? "";
		},
		async boundary(message: any, id = `reply-${++counter}`) {
			entries.push({ id, type: "message", message });
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
export type Harness = ReturnType<typeof harness>;
