/** Pi lifecycle coordinator. Boundary proposals and settled commands share one action registry and episode. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	AgentSettledEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { builtinActions } from "../actions/builtins.ts";
import {
	type ActionContext,
	type ActionDefinition,
	type ActionResult,
	isRecoveryChain,
	RESUME_RECOVERY,
	type RecoveryChain,
} from "../actions/protocol.ts";
import { ActionRegistry } from "../actions/registry.ts";
import type { Settings } from "../extension/settings.ts";
import { type Hit, isActive, matchFailure } from "../policy/config.ts";
import { formatDelay, retryDelay } from "../policy/delay.ts";
import { failureText, isFailure, isSuccess } from "../policy/failure.ts";
import { resolveLimits } from "../policy/policy.ts";
import { errorText, isRecord } from "../util.ts";
import { Episode } from "./episode.ts";
import { INPUT_RECORD, TaskPrompt } from "./task-prompt.ts";

export interface RunState {
	phase: "idle" | "waiting" | "submitted" | "retrying" | "queued" | "executing" | "stopped";
	hit?: Hit;
	invocationId?: string;
	result?: ActionResult["kind"];
	message?: string;
}
export interface OnwardStatus {
	state: RunState;
	failures: number;
	started: number;
	handoffs: number;
}
interface Invocation {
	id: string;
	hit: Hit;
	definition: ActionDefinition;
	targetId: string;
	controller: AbortController;
	config: Settings["config"];
	sessionId: string;
	taskPrompt: string | undefined;
}
const shared = globalThis as typeof globalThis & { __piOnwardRecoveryOwners?: Map<string, object> };
shared.__piOnwardRecoveryOwners ??= new Map();
const owners = shared.__piOnwardRecoveryOwners;
const ENTRY_PATH = fileURLToPath(new URL("../extension/index.ts", import.meta.url));

export class Recovery {
	readonly registry = new ActionRegistry();
	private episode: Episode;
	private state: RunState = { phase: "idle" };
	private pending: Invocation | undefined;
	private disposed = false;
	private sessionId: string | undefined;
	private readonly taskPrompt = new TaskPrompt();
	private statusText: string | undefined;
	private restored: { sessionId: string; chain: RecoveryChain } | undefined;
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly settings: Settings,
	) {
		this.episode = new Episode(resolveLimits(settings.config.limits).maxHandoffs);
		pi.events.on(RESUME_RECOVERY, (value) => {
			if (!isRecord(value) || typeof value.sessionId !== "string" || !isRecoveryChain(value.chain)) return;
			if (this.disposed || (this.sessionId && value.sessionId !== this.sessionId)) return;
			if (this.sessionId === value.sessionId) {
				this.episode.chain = { ...value.chain };
			} else this.restored = { sessionId: value.sessionId, chain: { ...value.chain } };
		});
	}
	start(ctx: ExtensionContext): void {
		this.sessionId = ctx.sessionManager.getSessionId();
		this.disposed = false;
		if (!this.owns(ctx)) return;
		this.registry.discover(this.pi, builtinActions(this.pi));
		this.settings.setActionValidator((config) => this.registry.problems(config));
		this.branch(ctx);
		if (this.restored?.sessionId === ctx.sessionManager.getSessionId())
			this.episode.chain = { ...this.restored.chain };
		this.restored = undefined;
	}
	input(event: InputEvent, ctx: ExtensionContext): void {
		if (this.owns(ctx)) this.taskPrompt.observe(event);
	}
	beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
		if (this.owns(ctx)) this.taskPrompt.begin(event);
	}
	agentStart(ctx: ExtensionContext): void {
		if (!this.owns(ctx)) return;
		if (this.state.phase === "submitted" && this.pending) {
			const invocation = this.pending;
			this.pending = undefined;
			if (ctx.signal?.aborted) {
				this.setState(ctx, { phase: "idle" });
				return;
			}
			this.episode.started++;
			this.setState(ctx, { phase: "retrying", hit: invocation.hit, invocationId: invocation.id });
		} else if (this.pending) {
			// Another extension continued after our proposal. The old settled action must not survive.
			this.pending.controller.abort();
			this.pending = undefined;
			this.setState(ctx, { phase: "idle" });
		}
	}
	messageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
		if (!this.owns(ctx)) return;
		if (event.message.role === "user") {
			const source = this.taskPrompt.consume();
			// Pi persists the user message after message_end handlers. This metadata follows the same branch,
			// contains no duplicate prompt text and never enters model context.
			this.pi.appendEntry(INPUT_RECORD, { timestamp: event.message.timestamp, source: source ?? "unknown" });
			if (source === "user") this.reset(ctx);
			else {
				// A consumed automatic message cancels stale work but preserves the recovery budget.
				this.pending?.controller.abort();
				this.pending = undefined;
				this.setState(ctx, { phase: "idle" });
			}
		} else if (isSuccess(event.message)) this.reset(ctx);
	}
	async beforeSettle(
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
	): Promise<AgentBeforeSettleEventResult | undefined> {
		if (
			!this.owns(ctx) ||
			this.disposed ||
			this.state.phase === "stopped" ||
			this.pending ||
			!isActive(this.settings.config)
		)
			return;
		if (event.outcome === "aborted" || ctx.signal?.aborted || event.continue || ctx.hasPendingMessages()) return;
		const entry = event.context.contextEntries.at(-1);
		const message = entry?.messages.at(-1);
		if (!entry || !isFailure(message) || !this.episode.observe(entry.sourceEntry.id)) return;
		const hit = matchFailure(this.settings.config, message, this.episode.failures);
		if (!hit) {
			this.finish(ctx, { kind: "stopped", message: "没有命中恢复规则" });
			return;
		}
		if (this.episode.failures > hit.limits.maxFailures) {
			this.finish(ctx, { kind: "stopped", message: `连续失败超过 ${hit.limits.maxFailures} 次上限` }, hit);
			return;
		}
		const definition = this.registry.get(hit.stage.action.use)?.definition;
		const problem = this.registry.check(hit.stage.action);
		if (problem || !definition) {
			this.finish(ctx, { kind: "failed", message: problem ?? "Action is not loaded" }, hit);
			return;
		}
		if (!definition.modes.includes(ctx.mode)) {
			this.finish(ctx, { kind: "failed", message: `${definition.name} does not support ${ctx.mode} mode` }, hit);
			return;
		}
		const chain = this.episode.chain;
		chain.maxHandoffs = Math.min(chain.maxHandoffs, hit.limits.maxHandoffs);
		if (definition.handoff && chain.handoffs >= chain.maxHandoffs) {
			this.finish(ctx, { kind: "stopped", message: `达到跨会话接管上限 ${chain.maxHandoffs} 次` }, hit);
			return;
		}
		this.taskPrompt.refresh(ctx.sessionManager.getBranch());
		const invocation: Invocation = {
			id: randomUUID(),
			hit,
			definition,
			targetId: entry.sourceEntry.id,
			controller: new AbortController(),
			config: this.settings.config,
			sessionId: ctx.sessionManager.getSessionId(),
			taskPrompt: this.taskPrompt.value,
		};
		this.pending = invocation;
		const signal = ctx.signal
			? AbortSignal.any([ctx.signal, invocation.controller.signal])
			: invocation.controller.signal;
		this.setState(ctx, { phase: "waiting", hit, invocationId: invocation.id });
		const delay = retryDelay(this.episode.failures - hit.stage.minFailures + 1, hit.stage.delay);
		this.notice(ctx, `${formatDelay(delay)}后执行 ${definition.name}（连续失败 ${this.episode.failures} 次）`);
		await wait(delay, signal);
		if (!this.current(invocation, ctx)) return;
		if (signal.aborted || ctx.hasPendingMessages()) {
			this.cancel(ctx, "等待已取消");
			return;
		}
		if (definition.phase === "settled") {
			this.setState(ctx, { phase: "queued", hit, invocationId: invocation.id });
			return;
		}
		const result = await this.invoke(invocation, {
			...this.execution(invocation, signal),
			phase: "boundary",
			targetId: invocation.targetId,
		});
		if (!this.current(invocation, ctx)) return;
		if (signal.aborted || ctx.hasPendingMessages()) {
			this.cancel(ctx, "续跑提议已取消");
			return;
		}
		if (result.kind === "continue") {
			this.setState(ctx, { phase: "submitted", hit, invocationId: invocation.id });
			return { entries: [...event.entries, ...result.entries], continue: true };
		}
		this.pending = undefined;
		this.finish(ctx, result, hit);
	}
	settled(event: AgentSettledEvent, ctx: ExtensionContext): void {
		if (!this.owns(ctx)) return;
		if (!ctx.hasPendingMessages()) this.taskPrompt.clearPending();
		if (event.aborted) {
			if (this.pending) this.cancel(ctx, "用户取消了恢复");
			return;
		}
		if (this.state.phase === "queued" && this.pending) {
			const invocation = this.pending;
			if (!this.current(invocation, ctx) || ctx.hasPendingMessages()) {
				this.cancel(ctx, "待执行动作已取消");
				return;
			}
			const command = this.pi
				.getCommands()
				.find(
					(command) =>
						command.source === "extension" &&
						command.sourceInfo.path === ENTRY_PATH &&
						(command.name === "onward" || command.name.startsWith("onward:")),
				);
			if (!command) {
				this.pending = undefined;
				this.finish(ctx, { kind: "failed", message: "Onward dispatch command is unavailable" }, invocation.hit);
				return;
			}
			// Pi defers this command until ALL agent_settled handlers finish.
			this.pi.sendUserMessage(`/${command.name} _dispatch ${invocation.id}`, { expandPromptTemplates: true });
			return;
		}
		if (this.state.phase === "submitted") {
			this.pending = undefined;
			this.setState(ctx, { phase: "idle" });
		}
	}
	/** Private nonce-based bridge, reached through Pi's real ExtensionCommandContext. */
	async dispatch(id: string, ctx: ExtensionCommandContext): Promise<void> {
		const invocation = this.pending;
		if (!invocation || invocation.id !== id || this.state.phase !== "queued" || !this.current(invocation, ctx))
			return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			this.cancel(ctx, "新的任务优先，待执行动作已取消");
			return;
		}
		this.setState(ctx, { phase: "executing", hit: invocation.hit, invocationId: id });
		if (invocation.definition.handoff) this.episode.chain.handoffs++;
		// Durable intent, without prompts or errors: it is diagnostic only and never replayed.
		this.pi.appendEntry("onward.action", {
			invocationId: id,
			episodeId: this.episode.id,
			action: invocation.definition.name,
			status: "started",
			chain: { ...this.episode.chain },
		});
		const result = await this.invoke(invocation, {
			...this.execution(invocation, invocation.controller.signal),
			phase: "settled",
			host: ctx,
		});
		if (!this.current(invocation, ctx)) return;
		if (invocation.definition.handoff && ["completed", "failed", "cancelled", "stopped"].includes(result.kind))
			this.episode.chain.handoffs--;
		this.pending = undefined;
		this.pi.appendEntry("onward.action", { invocationId: id, status: result.kind });
		this.finish(ctx, result, invocation.hit);
	}
	branch(ctx: ExtensionContext): void {
		if (!this.owns(ctx)) return;
		this.taskPrompt.restore(ctx.sessionManager.getBranch());
		this.reset(ctx);
	}
	stop(ctx: ExtensionContext): void {
		if (this.owns(ctx)) this.reset(ctx);
	}
	shutdown(ctx: ExtensionContext): void {
		this.taskPrompt.clearPending();
		this.pending?.controller.abort();
		this.pending = undefined;
		this.disposed = true;
		if (owners.get(ctx.sessionManager.getSessionId()) === this) {
			this.setState(ctx, { phase: "idle" });
			owners.delete(ctx.sessionManager.getSessionId());
		}
		this.registry.clear();
	}
	status(): OnwardStatus {
		return {
			state: this.state,
			failures: this.episode.failures,
			started: this.episode.started,
			handoffs: this.episode.chain.handoffs,
		};
	}
	private execution(invocation: Invocation, signal: AbortSignal) {
		const { failure, rule, stage } = invocation.hit;
		return {
			invocationId: invocation.id,
			episodeId: this.episode.id,
			sessionId: invocation.sessionId,
			rule: rule.name,
			failures: this.episode.failures,
			minFailures: stage.minFailures,
			taskPrompt: invocation.taskPrompt,
			signal,
			chain: Object.freeze({ ...this.episode.chain }),
			failure: Object.freeze({
				kind: failure.stopReason === "error" ? ("error" as const) : ("empty" as const),
				text: failureText(failure),
				provider: failure.provider,
				model: failure.model,
			}),
		};
	}
	private async invoke(invocation: Invocation, context: ActionContext): Promise<ActionResult> {
		const timeout = new AbortController();
		const signal = AbortSignal.any([context.signal, timeout.signal]);
		const timer = setTimeout(() => timeout.abort(), invocation.hit.limits.actionTimeout);
		try {
			if (signal.aborted) return { kind: "cancelled", message: "动作已取消" };
			const execute = async (): Promise<ActionResult> => {
				const definition = invocation.definition;
				const params = this.registry.parameters(invocation.hit.stage.action);
				if (definition.phase === "boundary" && context.phase === "boundary")
					return definition.execute(params, { ...context, signal });
				if (definition.phase === "settled" && context.phase === "settled")
					return definition.execute(params, { ...context, signal });
				return { kind: "failed", message: "Action execution phase does not match its context" };
			};
			const result = await raceAbort(execute(), signal);
			if (signal.aborted)
				return {
					kind: "unknown",
					message: timeout.signal.aborted
						? "Action timed out; outcome unknown; not replayed"
						: "Execution cancelled; side-effect outcome unknown",
				};
			if (!validResult(result, invocation.definition))
				return { kind: "unknown", message: "Action returned an invalid result; not replayed" };
			return result;
		} catch (error) {
			return { kind: "unknown", message: `Action threw an exception; outcome unknown: ${errorText(error)}` };
		} finally {
			clearTimeout(timer);
		}
	}
	private current(invocation: Invocation, ctx: ExtensionContext): boolean {
		return (
			!this.disposed &&
			this.pending === invocation &&
			!invocation.controller.signal.aborted &&
			invocation.config === this.settings.config &&
			isActive(this.settings.config) &&
			ctx.sessionManager.getSessionId() === invocation.sessionId &&
			owners.get(invocation.sessionId) === this
		);
	}
	private owns(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
		if (this.disposed) return false;
		const id = ctx.sessionManager.getSessionId();
		if (!owners.has(id)) owners.set(id, this);
		return owners.get(id) === this;
	}
	private reset(ctx: ExtensionContext): void {
		this.pending?.controller.abort();
		this.pending = undefined;
		this.episode = new Episode(resolveLimits(this.settings.config.limits).maxHandoffs);
		this.setState(ctx, { phase: "idle" });
	}
	private cancel(ctx: ExtensionContext, message: string): void {
		const hit = this.pending?.hit;
		this.pending?.controller.abort();
		this.pending = undefined;
		if (this.state.phase !== "idle") this.finish(ctx, { kind: "cancelled", message }, hit);
	}
	private finish(ctx: ExtensionContext, result: ActionResult, hit?: Hit): void {
		const message = "message" in result ? result.message : undefined;
		this.setState(ctx, { phase: "stopped", hit, result: result.kind, message });
		this.notice(
			ctx,
			message ?? `${hit?.stage.action.use ?? "恢复"}：${result.kind}`,
			!["completed", "handoff", "dispatched"].includes(result.kind),
		);
	}
	private notice(ctx: ExtensionContext, text: string, warning = false): void {
		if (ctx.hasUI) ctx.ui.notify(`onward：${text}`, warning ? "warning" : "info");
	}
	private setState(ctx: ExtensionContext, state: RunState): void {
		this.state = state;
		const after = stateText(state, this.episode.failures);
		if (ctx.hasUI && this.statusText !== after) ctx.ui.setStatus("pi-onward", after);
		this.statusText = after;
	}
}
export function stateText(state: RunState, failures: number): string | undefined {
	if (state.phase === "idle") return undefined;
	const phases = {
		waiting: "等待",
		submitted: "提议已提交",
		retrying: "续跑中",
		queued: "待执行",
		executing: "执行中",
		stopped: "已停止",
	};
	return `${state.phase === "stopped" ? "🛑" : "⏩"} onward · ${phases[state.phase]} · 失败 ${failures} 次${state.hit ? ` · ${state.hit.stage.action.use}` : ""}`;
}
function validResult(value: unknown, definition: ActionDefinition): value is ActionResult {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (value.kind === "continue")
		return (
			definition.phase === "boundary" &&
			Array.isArray(value.entries) &&
			value.entries.every(
				(entry: unknown) =>
					isRecord(entry) &&
					["custom", "custom_message", "context_edit", "compaction"].includes(String(entry.type)),
			)
		);
	if (value.kind === "handoff" && !definition.handoff) return false;
	if (["completed", "dispatched", "handoff"].includes(value.kind))
		return value.message === undefined || typeof value.message === "string";
	return ["stopped", "failed", "cancelled", "unknown"].includes(value.kind) && typeof value.message === "string";
}
async function wait(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted || ms <= 0) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	let abort: () => void = () => {};
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				abort = () => resolve(undefined);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
