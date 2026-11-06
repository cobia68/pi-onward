/** 单个间隔的上限，防止手滑写成几小时。 */
const MAX_DELAY_MS = 3_600_000;
const MAX_STEPS = 20;

export type Delay = { kind: "list"; steps: readonly number[] } | { kind: "ramp"; step: number; cap: number };

export const DELAY_SYNTAX = "5s,10s,30s or 3s..15s";
const MALFORMED = `must use ${DELAY_SYNTAX}, with ms, s, or m on each value`;

/** Schema 只校验格式；时长、列表长度与区间关系由 parseDelay 校验。 */
const DURATION = "\\d+(\\.\\d+)?(ms|s|m)";
export const DELAY_PATTERN = `^\\s*(${DURATION}\\.\\.${DURATION}|${DURATION}(\\s*,\\s*${DURATION})*)\\s*$`;

/** 合法时返回间隔，否则返回原因。 */
export function parseDelay(text: string): Delay | string {
	const value = text.trim();
	const range = /^([^,\s]+?)\.\.([^,\s]+)$/.exec(value);
	if (range) {
		const step = parseDuration(range[1]!);
		const cap = parseDuration(range[2]!);
		if (step === undefined || cap === undefined) return MALFORMED;
		if (step <= 0 || cap < step) return "ramp start must be positive and the cap must not be smaller than the start";
		return { kind: "ramp", step, cap };
	}
	const parts = value.split(",").map((part) => part.trim());
	const steps = parts.map(parseDuration);
	if (!value || steps.some((ms) => ms === undefined)) return MALFORMED;
	if (steps.length > MAX_STEPS) return `must contain at most ${MAX_STEPS} delay values`;
	return { kind: "list", steps: steps as number[] };
}

/** attempt 从 1 开始。 */
export function retryDelay(attempt: number, delay: Delay): number {
	if (delay.kind === "list") return delay.steps[Math.min(attempt, delay.steps.length) - 1]!;
	return Math.min(delay.step * attempt, delay.cap);
}

/** 配置文件使用的带单位写法。 */
export function delayText(delay: Delay): string {
	return delay.kind === "ramp"
		? `${duration(delay.step)}..${duration(delay.cap)}`
		: delay.steps.map(duration).join(",");
}

function duration(ms: number): string {
	if (ms !== 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return ms < 1000 ? `${ms}ms` : `${ms / 1000}s`;
}

/** 供界面展示，不用于写回配置。 */
export function formatDelay(ms: number): string {
	if (ms < 1000) return `${ms} 毫秒`;
	if (ms < 60_000) return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${(ms / 1000).toFixed(1)} 秒`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000 } as const;

/** 带单位时长转毫秒，超过一小时返回 undefined。 */
export function parseDuration(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text);
	if (!match) return undefined;
	const ms = Math.round(Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]);
	return ms <= MAX_DELAY_MS ? ms : undefined;
}
