/**
 * 续跑的参数：一张字段表，设置文件、规则、命令、帮助和补全都用它。设置文件顶层写的就是每条规则的默认值，
 * 规则里同名的字段覆盖它。
 */
import { DELAY_SYNTAX, type Delay, delayText, parseDelay } from "./delay.ts";

/** message 发一条看得见的消息再接着跑；resend 从上下文里省略失败的那条，重发同一个请求；stop 不续跑，只提醒。 */
export type Action = "message" | "resend" | "stop";

export interface Policy {
	action: Action;
	/** message 发的消息，可含 {attempt} {max} {error} {rule}。 */
	prompt: string;
	/** 连续失败时最多续跑几次，正常返回一次就从头算。 */
	maxRetries: number;
	/** 同一个错误最多续跑几次：连续出现超过这么多次就彻底停。 */
	maxSameError: number;
	delay: Delay;
}

export type PolicyPatch = Partial<Policy>;

export interface Field<K extends keyof Policy = keyof Policy> {
	name: K;
	/** 帮助里的写法。 */
	syntax: string;
	description: string;
	/** 补全的候选值。 */
	choices?: readonly { value: string; description: string }[];
	/** 设置文件里的值；合法时返回 value，否则返回原因。 */
	read(value: unknown): { value: Policy[K] } | { problem: string };
	/** 命令里的文字 → 设置文件里的值。 */
	fromText(text: string): unknown;
	/** 给人看的值。 */
	show(value: Policy[K]): string;
}

const ACTIONS: readonly { value: Action; description: string }[] = [
	{ value: "message", description: "发一条看得见的消息再接着跑" },
	{ value: "resend", description: "静默重发同一个请求" },
	{ value: "stop", description: "不续跑，只提醒" },
];

const field = <K extends keyof Policy>(spec: Field<K>): Field<K> => spec;

export const FIELDS: readonly Field[] = [
	field({
		name: "action",
		syntax: ACTIONS.map((item) => item.value).join(" | "),
		description: "怎么续跑",
		choices: ACTIONS,
		read: (v) =>
			ACTIONS.some((item) => item.value === v)
				? { value: v as Action }
				: { problem: "只能是 message、resend 或 stop" },
		fromText: (text) => text,
		show: String,
	}),
	field({
		name: "prompt",
		syntax: "文字",
		description: "message 发的消息，可含 {attempt} {max} {error} {rule}",
		read: (v) =>
			typeof v === "string" && v.trim() && v.trim().length <= 500
				? { value: v.trim() }
				: { problem: "需要 1–500 字的文字" },
		fromText: (text) => text,
		show: (prompt) => `「${prompt}」`,
	}),
	field({
		name: "maxRetries",
		syntax: "1–50",
		description: "连续失败时最多续跑几次",
		read: (v) => integer(v, 1, 50),
		fromText: number,
		show: String,
	}),
	field({
		name: "maxSameError",
		syntax: "1–100",
		description: "同一个错误最多续跑几次，再出现就彻底停",
		read: (v) => integer(v, 1, 100),
		fromText: number,
		show: String,
	}),
	field({
		name: "delay",
		syntax: DELAY_SYNTAX,
		description: "列表按顺序等，最后一个值重复；起步..封顶按次数增长",
		read: (v) => {
			const delay = typeof v === "string" ? parseDelay(v) : `写成 ${DELAY_SYNTAX}`;
			return typeof delay === "string" ? { problem: delay } : { value: delay };
		},
		fromText: (text) => text,
		show: delayText,
	}),
];

export const FIELD_NAMES: readonly string[] = FIELDS.map((item) => item.name);

export function fieldNamed(name: string): Field | undefined {
	return FIELDS.find((item) => item.name.toLowerCase() === name.toLowerCase());
}

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze<Policy>({
	action: "message",
	prompt: "继续",
	maxRetries: 10,
	maxSameError: 10,
	delay: { kind: "ramp", step: 3_000, cap: 15_000 },
});

/** 内置默认值 ← 设置文件顶层 ← 规则自己的字段。 */
export function resolvePolicy(defaults: PolicyPatch, rule: PolicyPatch = {}): Policy {
	return { ...DEFAULT_POLICY, ...defaults, ...rule };
}

/**
 * 读设置文件顶层或一条规则里的参数：合法的收下，不合法的记一条问题，不夹到范围内、也不退回默认值。
 * 有问题的设置整份不生效（见 config.ts），所以这里不用分哪些字段要紧。不是参数的键交给调用方。
 * `where` 是问题里的位置前缀，如 `rules[2]（auth）.`。
 */
export function readParams(raw: Record<string, unknown>, where: string, problems: string[]): PolicyPatch {
	const patch: Record<string, unknown> = {};
	for (const item of FIELDS) {
		if (!Object.hasOwn(raw, item.name)) continue;
		const result = item.read(raw[item.name]);
		if ("value" in result) patch[item.name] = result.value;
		else problems.push(`${where}${item.name} ${result.problem}`);
	}
	return patch;
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

function integer(value: unknown, min: number, max: number): { value: number } | { problem: string } {
	return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
		? { value: value as number }
		: { problem: `需要 ${min}–${max} 的整数` };
}

/** 不是数字的文字原样交给 read，由它说明要什么。 */
function number(text: string): unknown {
	return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text;
}
