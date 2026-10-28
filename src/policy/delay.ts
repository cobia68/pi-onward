/**
 * 重试间隔 `delay`，一个带单位的字符串，设置文件和命令写法一样：
 *  - `5s,10s,30s`：按列表来，最后一个值重复；
 *  - `3s..15s`：按次数增长，第 n 次等 min(3 秒 × n, 15 秒)。
 */

/** 单个间隔的上限，防止手滑写成几小时。 */
const MAX_DELAY_MS = 3_600_000;
const MAX_STEPS = 20;

export type Delay = { kind: "list"; steps: readonly number[] } | { kind: "ramp"; step: number; cap: number };

export const DELAY_SYNTAX = "5s,10s,30s 或 3s..15s";
const MALFORMED = `写成 ${DELAY_SYNTAX}，每个值带单位 ms、s 或 m`;

/** 合法时返回间隔，否则返回原因。 */
export function parseDelay(text: string): Delay | string {
	const value = text.trim();
	const range = /^([^,\s]+?)\.\.([^,\s]+)$/.exec(value);
	if (range) {
		const step = parseDuration(range[1]!);
		const cap = parseDuration(range[2]!);
		if (step === undefined || cap === undefined) return MALFORMED;
		if (step <= 0 || cap < step) return "按次增长要写成 起步..封顶，起步大于 0、封顶不小于起步";
		return { kind: "ramp", step, cap };
	}
	const parts = value.split(",").map((part) => part.trim());
	const steps = parts.map(parseDuration);
	if (!value || steps.some((ms) => ms === undefined)) return MALFORMED;
	if (steps.length > MAX_STEPS) return `列表最多 ${MAX_STEPS} 个值`;
	return { kind: "list", steps: steps as number[] };
}

/** 第 `attempt` 次（从 1 开始）续跑前等多久。 */
export function retryDelay(attempt: number, delay: Delay): number {
	const n = Math.max(attempt, 1);
	if (delay.kind === "list") return delay.steps[Math.min(n, delay.steps.length) - 1]!;
	return Math.min(delay.step * n, delay.cap);
}

/** 前 `count` 次的间隔之和。 */
export function totalDelay(count: number, delay: Delay): number {
	let sum = 0;
	for (let n = 1; n <= count; n++) sum += retryDelay(n, delay);
	return sum;
}

/** 写回设置文件的样子：`3s..15s`、`30s,1m,2m`。 */
export function delayText(delay: Delay): string {
	return delay.kind === "ramp"
		? `${duration(delay.step)}..${duration(delay.cap)}`
		: delay.steps.map(duration).join(",");
}

/** 毫秒 → 最短的带单位写法：`500ms`、`1.5s`、`2m`。 */
function duration(ms: number): string {
	if (ms !== 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return ms < 1000 ? `${ms}ms` : `${ms / 1000}s`;
}

/** 给人看：20 毫秒 / 5 秒 / 1.5 秒 / 2 分 30 秒。 */
export function formatDelay(ms: number): string {
	if (ms < 1000) return `${ms} 毫秒`;
	if (ms < 60_000) return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${(ms / 1000).toFixed(1)} 秒`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000 } as const;

/** `500ms` / `1.5s` / `2m` → 毫秒；必须带单位，超过一小时的不收。 */
function parseDuration(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/i.exec(text);
	if (!match) return undefined;
	const ms = Math.round(Number(match[1]) * UNIT_MS[match[2]!.toLowerCase() as keyof typeof UNIT_MS]);
	return ms <= MAX_DELAY_MS ? ms : undefined;
}
