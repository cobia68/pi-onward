/**
 * 一轮以错误收尾、命中规则时，在 `agent_before_settle` 边界上等一会儿，再要 pi 接着跑：
 *  - message：追加一条看得见的消息（默认「继续」），模型照常读到；
 *  - resend：用 `context_edit` 把失败的那条从模型上下文里省略，重发同一个请求。失败的记录仍留在会话里。
 *
 * 等待和续跑都在这一轮之内完成，不靠落定后的定时器，所以 `pi -p`、RPC、subagent 子会话里一样生效。
 */
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	ExtensionContext,
	MessageEndEvent,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { type Hit, matchFailure } from "../policy/config.ts";
import { isSuccess } from "../policy/failure.ts";
import { renderPrompt } from "../policy/policy.ts";
import { type Progress, type Retry, Tracker } from "../policy/tracker.ts";
import type { Settings } from "./settings.ts";
import { errorExcerpt, giveUpNotice, giveUpStatus, retryNotice, retryStatus, say } from "./text.ts";

type Ctx = Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">;

/** 状态栏里本扩展的那一格。 */
const STATUS_KEY = "pi-onward";

/** 续跑消息的类型，render.ts 按它画。 */
export const CUSTOM_TYPE = "pi-onward";

/** 续跑消息带的 details：只给界面画标签，模型只读到 content。 */
export interface ContinueDetails {
	rule: string;
	attempt: number;
	max: number;
}

/** 怎么接着跑：resend 省略失败的那条重发，message 追加一条文字消息。 */
export type Continue =
	| Extract<SessionBoundaryDraft, { type: "context_edit" }>
	| (Extract<SessionBoundaryDraft, { type: "custom_message" }> & { content: string; details: ContinueDetails });

/**
 * 每个会话由哪个实例负责。同一个会话装了两份（例如 subagent 既按包加载、又按路径加载了一份副本），
 * 两份各自计数：一份到上限停手，另一份照样续跑，互相接力永远停不下来。所以只让先到的那份干活；
 * reload 和子会话销毁前 pi 都会发 session_shutdown，在那里交还。
 */
const shared = globalThis as typeof globalThis & { __piOnwardOwners?: Map<string, object> };
shared.__piOnwardOwners ??= new Map();
const owners = shared.__piOnwardOwners;

export class Onward {
	private readonly settings: Settings;
	private readonly tracker = new Tracker();
	/**
	 * 接下来的 agent_start 是我们 `continue: true` 出来的。pi 会为它重新发 agent_start，
	 * 按新一轮清零的话计数永远到不了上限，会死循环。
	 */
	private continuing = false;
	/** 正在等待的那次续跑；关掉、恢复默认、会话结束时打断它。 */
	private waiting: AbortController | undefined;
	/**
	 * 状态栏里写着什么：retrying 是第几次续跑，这一轮结束就清掉；gave-up 是停了，留到恢复或用户发新消息。
	 * 只有干活的那份会写，所以清的时候不用再问是谁的。
	 */
	private statusBar: "retrying" | "gave-up" | undefined;

	constructor(settings: Settings) {
		this.settings = settings;
	}

	agentStart(ctx: Ctx): void {
		if (!this.owns(ctx)) return;
		if (!this.continuing) this.reset(ctx);
		this.continuing = false;
	}

	messageEnd(event: MessageEndEvent, ctx: Ctx): void {
		// 续跑之后只要正常返回过一次就算恢复了：后面再出错是新的一串，次数从头算。
		if (this.owns(ctx) && isSuccess(event.message)) this.reset(ctx);
	}

	/** 等待期间这一轮仍算忙：按 Esc 打断等待；用户输入的消息优先，我们让路。 */
	async beforeSettle(
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
	): Promise<AgentBeforeSettleEventResult | undefined> {
		this.continuing = false;
		if (!this.owns(ctx)) return undefined;
		// 别的扩展已经要求继续：再插一条会改掉它要重发的内容。
		if (event.outcome === "aborted" || event.continue || ctx.hasPendingMessages()) return undefined;
		const entry = event.context.contextEntries.at(-1);
		const hit = matchFailure(this.settings.config, entry?.messages.at(-1));
		if (!entry || !hit) return undefined;
		const step = this.advance(hit, ctx);
		if (!step) return undefined;
		const draft: Continue =
			hit.policy.action === "resend"
				? { type: "context_edit", targetId: entry.sourceEntry.id, replacement: null }
				: {
						type: "custom_message",
						customType: CUSTOM_TYPE,
						content: this.prompt(hit, step),
						display: true,
						details: { rule: hit.rule.name, attempt: step.attempt, max: hit.policy.maxRetries },
					};
		say(ctx, retryNotice(step, draft));
		this.setStatus(ctx, "retrying", retryStatus(hit, step));
		if (await this.wait(step.delay, ctx.signal)) return undefined;
		// 等的时候用户发了消息：pi 会接着处理它，这算用户开的新一轮。
		if (ctx.hasPendingMessages()) {
			this.reset(ctx);
			return undefined;
		}
		this.continuing = true;
		// 边界结果会整体替换前面扩展提出的条目，所以带上它们。
		return { entries: [...event.entries, draft], continue: true };
	}

	/**
	 * 这一轮彻底结束了；pi 不接受续跑时，`continuing` 不能留到下一轮。没有接着跑（按了 Esc、错误没命中规则），
	 * 「第几次」就不再成立；停了的提示留着。
	 */
	settled(ctx: Ctx): void {
		this.continuing = false;
		if (this.statusBar === "retrying") this.setStatus(ctx, undefined);
	}

	/** 关掉、恢复默认时：打断正在等的续跑，清零计数。 */
	stop(ctx: Ctx): void {
		this.waiting?.abort();
		this.reset(ctx);
		this.continuing = false;
	}

	shutdown(ctx: Ctx): void {
		this.stop(ctx);
		const session = ctx.sessionManager.getSessionId();
		if (owners.get(session) === this) owners.delete(session);
	}

	progress(): Progress {
		return this.tracker.progress();
	}

	private owns(ctx: Ctx): boolean {
		const session = ctx.sessionManager.getSessionId();
		const owner = owners.get(session);
		if (owner === undefined) owners.set(session, this);
		return owner === undefined || owner === this;
	}

	/** 再试就返回这一步；该停了就提醒并返回 undefined。 */
	private advance(hit: Hit, ctx: ExtensionContext): Retry | undefined {
		const step = this.tracker.next(hit.rule.name, hit.failure, hit.policy);
		if (step.retry) return step;
		if (step.notify) say(ctx, giveUpNotice(step));
		this.setStatus(ctx, "gave-up", giveUpStatus(hit, step));
		return undefined;
	}

	/** 计数从头算，状态栏也清掉。 */
	private reset(ctx: Ctx): void {
		this.tracker.reset();
		if (this.statusBar !== undefined) this.setStatus(ctx, undefined);
	}

	/** 没有界面时（`pi -p`）不写；RPC 下 pi 把它发给客户端。 */
	private setStatus(ctx: Ctx, status: "retrying" | "gave-up" | undefined, text?: string): void {
		this.statusBar = status;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	}

	private prompt(hit: Hit, step: Retry): string {
		return renderPrompt(hit.policy.prompt, {
			attempt: step.attempt,
			max: hit.policy.maxRetries,
			error: errorExcerpt(hit.failure, 120),
			rule: hit.rule.name,
		});
	}

	/** 返回 true 表示被打断。 */
	private async wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
		const waiting = new AbortController();
		this.waiting = waiting;
		try {
			return await sleep(ms, signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal);
		} finally {
			if (this.waiting === waiting) this.waiting = undefined;
		}
	}
}

/** 不 unref：等待期间这一轮还忙，进程不该因为只剩它在等就退出。 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true);
	if (ms <= 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		const finish = (aborted: boolean): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(aborted);
		};
		const onAbort = (): void => finish(true);
		const timer = setTimeout(() => finish(false), ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
