/** 一条规则怎么续跑：方式、次数、间隔、同错上限，以及这些参数的校验。 */
import { isRecord } from "../util.ts";
import { type DelayPolicy, MAX_DELAY_MS } from "./delay.ts";

/** `message` 发一条用户消息；`silent` 从上下文里省略失败的那条，再重发同一个请求。 */
export type Mode = "message" | "silent";

export interface Policy extends DelayPolicy {
	mode: Mode;
	/** message 模式发的消息，可含 {attempt} {max} {error} {rule}。 */
	prompt: string;
	/** 连续失败时最多续跑几次，正常返回一次就从头算；0 表示命中就停、只提醒。 */
	maxRetries: number;
	/** 同一个错误连续出现超过这么多次就彻底停。 */
	sameErrorLimit: number;
}

export type PolicyPatch = Partial<Policy>;

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
	mode: "message",
	prompt: "继续",
	maxRetries: 10,
	sameErrorLimit: 10,
	retryDelaysMs: [],
	retryBaseMs: 3_000,
	retryCapMs: 15_000,
});

/** 内置默认值 ← 设置里的 defaults ← 规则自己的参数。 */
export function resolvePolicy(defaults: PolicyPatch, rule: PolicyPatch = {}): Policy {
	return { ...DEFAULT_POLICY, ...defaults, ...rule };
}

interface Field {
	expect: string;
	/** 合法时返回（夹到范围内的）值，否则 undefined。 */
	parse(value: unknown): unknown;
}

const FIELDS: Record<keyof Policy, Field> = {
	mode: {
		expect: "只能是 message 或 silent",
		parse: (v) => (v === "message" || v === "silent" ? v : undefined),
	},
	prompt: {
		expect: "需要非空字符串",
		parse: (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : undefined),
	},
	maxRetries: { expect: "需要数字", parse: (v) => clampInt(v, 0, 50) },
	sameErrorLimit: { expect: "需要数字", parse: (v) => clampInt(v, 1, 100) },
	retryBaseMs: { expect: "需要数字（毫秒）", parse: (v) => clampInt(v, 0, MAX_DELAY_MS) },
	retryCapMs: { expect: "需要数字（毫秒）", parse: (v) => clampInt(v, 0, MAX_DELAY_MS) },
	retryDelaysMs: {
		expect: "需要数组（毫秒）",
		parse: (v) =>
			Array.isArray(v)
				? v
						.filter((ms): ms is number => isNumber(ms) && ms >= 0)
						.slice(0, 20)
						.map((ms) => Math.min(Math.round(ms), MAX_DELAY_MS))
				: undefined,
	},
};

/** 只留下认得、合法的参数，数值夹到范围内；坏值丢掉并记一条问题。 */
export function parsePolicyPatch(raw: unknown, where: string, problems: string[] = []): PolicyPatch {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		problems.push(`${where} 不是对象，已忽略`);
		return {};
	}
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const field = Object.hasOwn(FIELDS, key) ? FIELDS[key as keyof Policy] : undefined;
		const parsed = field?.parse(value);
		if (parsed !== undefined) patch[key] = parsed;
		else problems.push(field ? `${where}.${key} ${field.expect}` : `${where}.${key} 不认识，已忽略`);
	}
	return patch as PolicyPatch;
}

export interface PromptVars {
	attempt: number;
	max: number;
	error: string;
	rule: string;
}

/** 不认识的占位原样留着。 */
export function renderPrompt(template: string, vars: PromptVars): string {
	return template.replace(/\{(attempt|max|error|rule)\}/g, (_, key: keyof PromptVars) => String(vars[key]));
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
	return isNumber(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : undefined;
}
