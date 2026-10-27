/** 重试间隔：按次数线性增长并封顶，或者写死一份列表。 */

/** 单个间隔的上限，防止手滑写成几小时。 */
export const MAX_DELAY_MS = 3_600_000;

export interface DelayPolicy {
	/** 非空时按列表来，最后一个值重复；空表示按次数增长：第 n 次等 min(base × n, cap)。 */
	retryDelaysMs: readonly number[];
	retryBaseMs: number;
	retryCapMs: number;
}

/** 第 `attempt` 次（从 1 开始）续跑前等多久。 */
export function retryDelay(attempt: number, policy: DelayPolicy): number {
	const n = Math.max(attempt, 1);
	const list = policy.retryDelaysMs;
	if (list.length) return list[Math.min(n, list.length) - 1]!;
	return Math.min(policy.retryBaseMs * n, policy.retryCapMs);
}

/** 前 `count` 次的间隔之和。 */
export function totalDelay(count: number, policy: DelayPolicy): number {
	let sum = 0;
	for (let n = 1; n <= count; n++) sum += retryDelay(n, policy);
	return sum;
}

/** 20 毫秒 / 5 秒 / 1.5 秒 / 2 分 30 秒。 */
export function formatDelay(ms: number): string {
	if (ms < 1000) return `${ms} 毫秒`;
	if (ms < 60_000) return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${(ms / 1000).toFixed(1)} 秒`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000 } as const;

/** `500ms` / `5s` / `2m` → 毫秒；不带单位按秒，超出上限的夹到上限。 */
export function parseDuration(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(text.trim());
	if (!match) return undefined;
	const unit = (match[2]?.toLowerCase() ?? "s") as keyof typeof UNIT_MS;
	return Math.min(Math.round(Number(match[1]) * UNIT_MS[unit]), MAX_DELAY_MS);
}
