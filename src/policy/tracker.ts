/**
 * 上次正常返回之后的连续失败计数。每条规则各自计次数，预算互不挤占；同一个错误的连续次数是全局的：
 * 不管落到哪条规则，同一个错误连着出现都说明没恢复。扩展在正常返回或用户开新一轮时 reset。
 */
import { retryDelay } from "./delay.ts";
import { errorSignature, type Failure } from "./failure.ts";
import type { Policy } from "./policy.ts";

export type StopReason = "no-retries" | "same-error" | "budget";

export type Retry = { retry: true; attempt: number; delay: number };
export type Stop = { retry: false; reason: StopReason; attempt: number; streak: number; notify: boolean };
export type Step = Retry | Stop;

/** 这一串失败里一共续跑了几次，同一个错误连续几次。 */
export interface Progress {
	used: number;
	streak: number;
}

export class Tracker {
	private readonly attempts = new Map<string, number>();
	private streak = 0;
	private signature: string | undefined;
	private warned = false;

	/** 记一次失败，给出下一步：等多久再试，还是停。 */
	next(ruleName: string, failure: Failure, policy: Policy): Step {
		const signature = errorSignature(failure);
		this.streak = signature === this.signature ? this.streak + 1 : 1;
		this.signature = signature;
		const used = this.attempts.get(ruleName) ?? 0;
		const reason = stopReason(used, this.streak, policy);
		if (reason) {
			// 停手只提醒一次，恢复之前再撞到也不刷屏。
			const notify = !this.warned;
			this.warned = true;
			return { retry: false, reason, attempt: used, streak: this.streak, notify };
		}
		this.attempts.set(ruleName, used + 1);
		return { retry: true, attempt: used + 1, delay: retryDelay(used + 1, policy) };
	}

	reset(): void {
		this.attempts.clear();
		this.streak = 0;
		this.signature = undefined;
		this.warned = false;
	}

	progress(): Progress {
		let used = 0;
		for (const n of this.attempts.values()) used += n;
		return { used, streak: this.streak };
	}
}

function stopReason(used: number, streak: number, policy: Policy): StopReason | undefined {
	if (policy.maxRetries === 0) return "no-retries";
	if (streak > policy.sameErrorLimit) return "same-error";
	if (used >= policy.maxRetries) return "budget";
	return undefined;
}
