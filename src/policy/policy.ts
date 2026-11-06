/** Recovery-wide limits. Stages own their actions and delays; there are no inherited action parameters. */
import { formatDelay, parseDuration } from "./delay.ts";

export interface Limits {
	maxFailures: number;
	maxHandoffs: number;
	/** Maximum execution time of one action, in milliseconds. Waiting delay is separate. */
	actionTimeout: number;
}
export type LimitsPatch = Partial<Limits>;
export interface Field<K extends keyof Limits = keyof Limits> {
	name: K;
	syntax: string;
	description: string;
	read(value: unknown): { value: Limits[K] } | { problem: string };
	fromText(text: string): unknown;
	show(value: Limits[K]): string;
	schema: Readonly<Record<string, unknown>>;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
	maxFailures: 20,
	maxHandoffs: 3,
	actionTimeout: 30_000,
});
const integer =
	(min: number, max: number) =>
	(value: unknown): { value: number } | { problem: string } =>
		Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
			? { value: value as number }
			: { problem: `must be an integer between ${min} and ${max}` };
export const FIELDS: readonly Field[] = [
	{
		name: "maxFailures",
		syntax: "1–1000",
		description: "一次恢复过程最多处理多少次失败；超过后停止",
		read: integer(1, 1000),
		fromText: (text) => (/^\d+$/.test(text) ? Number(text) : text),
		show: String,
		schema: { type: "integer", minimum: 1, maximum: 1000 },
	},
	{
		name: "maxHandoffs",
		syntax: "0–50",
		description: "恢复链最多跨会话接管多少次；0 禁止接管",
		read: integer(0, 50),
		fromText: (text) => (/^\d+$/.test(text) ? Number(text) : text),
		show: String,
		schema: { type: "integer", minimum: 0, maximum: 50 },
	},
	{
		name: "actionTimeout",
		syntax: "30s",
		description: "单次动作执行时限；超时结果未知，不自动重放",
		read(value) {
			const ms = typeof value === "string" ? parseDuration(value) : undefined;
			return ms !== undefined && ms > 0
				? { value: ms }
				: { problem: "must be a positive duration no greater than 60m, using ms, s, or m" };
		},
		fromText: String,
		show: formatDelay,
		schema: { type: "string", pattern: "^\\d+(\\.\\d+)?(ms|s|m)$" },
	},
];
export const FIELD_NAMES = FIELDS.map((field) => field.name);
export const fieldNamed = (name: string): Field | undefined => FIELDS.find((field) => field.name === name);
export const resolveLimits = (patch: LimitsPatch): Limits => ({ ...DEFAULT_LIMITS, ...patch });

export function readLimits(raw: Record<string, unknown>, problems: string[]): LimitsPatch {
	const patch: LimitsPatch = {};
	for (const field of FIELDS) {
		if (!Object.hasOwn(raw, field.name)) continue;
		const result = field.read(raw[field.name]);
		if ("problem" in result) problems.push(`${field.name} ${result.problem}`);
		else patch[field.name] = result.value;
	}
	return patch;
}
