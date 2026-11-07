/** Public, in-process action protocol. Registration is synchronous; execution returns a receipt. */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

export type ExtensionMode = ExtensionContext["mode"];
export const DISCOVER_ACTIONS = "onward:discover-actions";
export const RESUME_RECOVERY = "onward:resume-recovery";
export const ACTION_NAME_PATTERN = "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$";
export type Parameters = Record<string, unknown>;
export type JsonSchema = Record<string, unknown>;

export interface ActionCall {
	use: string;
	with?: Parameters;
}

export interface FailureSnapshot {
	kind: "error" | "empty";
	text: string;
	provider: string;
	model: string;
}

/** Transfer this data through the provider's durable handoff, never through a cached host context. */
export interface RecoveryChain {
	id: string;
	handoffs: number;
	maxHandoffs: number;
}

interface Execution {
	invocationId: string;
	episodeId: string;
	sessionId: string;
	rule: string;
	failures: number;
	minFailures: number;
	failure: Readonly<FailureSnapshot>;
	/** Accepted task text, rebuilt from persisted input origins and stable across automatic continuations. */
	taskPrompt?: string;
	chain: Readonly<RecoveryChain>;
	signal: AbortSignal;
}

export interface BoundaryActionContext extends Execution {
	phase: "boundary";
	targetId: string;
}
export interface SettledActionContext extends Execution {
	phase: "settled";
	/** A fresh command context supplied by Pi after all settled observers have finished. */
	host: ExtensionCommandContext;
}
export type ActionContext = BoundaryActionContext | SettledActionContext;

export type TerminalResult =
	| { kind: "completed" | "dispatched" | "handoff"; message?: string }
	| { kind: "stopped" | "failed" | "cancelled" | "unknown"; message: string };
export type BoundaryResult = TerminalResult | { kind: "continue"; entries: SessionBoundaryDraft[] };
export type ActionResult = BoundaryResult;

interface Definition {
	name: string;
	description: string;
	parameters: JsonSchema;
	modes: readonly ExtensionMode[];
}
export type ActionDefinition = Definition &
	(
		| {
				phase: "boundary";
				handoff?: never;
				execute(params: Parameters, context: BoundaryActionContext): BoundaryResult | Promise<BoundaryResult>;
		  }
		| {
				phase: "settled";
				/** Reserve a cross-process handoff before invoking this action. */
				handoff?: boolean;
				execute(params: Parameters, context: SettledActionContext): TerminalResult | Promise<TerminalResult>;
		  }
	);

export interface ActionDiscovery {
	add(definition: ActionDefinition): void;
}

/** Call from the extension factory, before session_start; works in either extension load order. */
export function provideAction(pi: Pick<ExtensionAPI, "events" | "on">, definition: ActionDefinition): () => void {
	let active = true;
	const guard = (): TerminalResult | undefined =>
		!active ? { kind: "cancelled", message: "Action provider has been unloaded" } : undefined;
	const provided: ActionDefinition =
		definition.phase === "boundary"
			? {
					...definition,
					execute: (params: Parameters, context: BoundaryActionContext) =>
						guard() ?? definition.execute(params, context),
				}
			: {
					...definition,
					execute: (params: Parameters, context: SettledActionContext) =>
						guard() ?? definition.execute(params, context),
				};
	const remove = pi.events.on(DISCOVER_ACTIONS, (request: unknown) => {
		if (active && isDiscovery(request)) request.add(provided);
	});
	const dispose = () => {
		active = false;
		remove();
	};
	pi.on("session_shutdown", dispose);
	return dispose;
}

export function isDiscovery(value: unknown): value is ActionDiscovery {
	return !!value && typeof value === "object" && "add" in value && typeof value.add === "function";
}

export function isRecoveryChain(value: unknown): value is RecoveryChain {
	if (!value || typeof value !== "object") return false;
	const chain = value as RecoveryChain;
	return (
		typeof chain.id === "string" &&
		chain.id.length > 0 &&
		chain.id.length <= 128 &&
		Number.isSafeInteger(chain.handoffs) &&
		chain.handoffs >= 0 &&
		Number.isSafeInteger(chain.maxHandoffs) &&
		chain.maxHandoffs >= 0 &&
		chain.handoffs <= chain.maxHandoffs
	);
}
