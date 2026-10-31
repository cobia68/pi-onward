/**
 * 规则 = 条件（when）+ 参数，按顺序第一条命中的生效。参数和设置文件顶层同名，只写和顶层不同的。
 * 没写 `when.empty` 的规则管出错，写了的只管空回复；不带 when 的兜底因此不会碰空回复。
 * 没有内置规则：没写或没命中，都不处理。读不懂的内容只记问题，不替用户猜；有问题时整份设置不生效（见 config.ts）。
 */
import { errorText, isRecord } from "../util.ts";
import type { Failure } from "./failure.ts";
import { FIELD_NAMES, type PolicyPatch, readParams } from "./policy.ts";

export interface RuleWhen {
	/** 只管空回复；只能是 true，不写就是管出错。 */
	empty?: true;
	/** 大小写不敏感，对原始错误文案匹配；读设置时编译一次。 */
	error?: RegExp;
	/** 通配，只有 `*` 有特殊含义。 */
	provider?: string;
	model?: string;
}

export interface Rule {
	name: string;
	enabled: boolean;
	when: RuleWhen;
	/** 规则自己写的参数，只覆盖写了的字段。 */
	patch: PolicyPatch;
}

export const RULE_KEYS: ReadonlySet<string> = new Set(["name", "enabled", "when", ...FIELD_NAMES]);

export function findRule(rules: readonly Rule[], failure: Failure): Rule | undefined {
	return rules.find((rule) => rule.enabled && matches(rule.when, failure));
}

function matches(when: RuleWhen, failure: Failure): boolean {
	if ((when.empty === true) !== (failure.stopReason === "stop")) return false;
	if (when.error !== undefined && !when.error.test(failure.errorMessage ?? "")) return false;
	if (when.provider !== undefined && !glob(when.provider, failure.provider)) return false;
	if (when.model !== undefined && !glob(when.model, failure.model)) return false;
	return true;
}

/** 大小写不敏感，整串匹配。 */
export function glob(pattern: string, value: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i").test(value);
}

/** 校验规则列表：读得懂的规则返回，读不懂的地方逐条记进 problems。 */
export function parseRules(raw: unknown, problems: string[]): Rule[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		problems.push("rules 需要数组");
		return [];
	}
	const rules: Rule[] = [];
	for (const [index, item] of raw.entries()) {
		const rule = parseRule(item, index, problems);
		if (!rule) continue;
		if (rules.some((r) => r.name === rule.name)) problems.push(`rules[${index}] 与前面的规则重名（${rule.name}）`);
		else rules.push(rule);
	}
	return rules;
}

/** 一处读不懂就不返回这条规则，所有问题都记下来，一次改完。 */
function parseRule(raw: unknown, index: number, problems: string[]): Rule | undefined {
	if (!isRecord(raw)) {
		problems.push(`rules[${index}] 不是对象`);
		return undefined;
	}
	const before = problems.length;
	const name = ruleName(raw.name, index);
	if (name === undefined) problems.push(`rules[${index}].name 需要非空文字`);
	const label = name === undefined ? `rules[${index}].` : `rules[${index}]（${name}）.`;
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
		problems.push(`${label}enabled 需要 true 或 false`);
	const when = parseWhen(raw.when, `${label}when`, problems);
	const patch = readParams(raw, label, problems);
	for (const key of Object.keys(raw)) if (!RULE_KEYS.has(key)) problems.push(`${label}${key} 不认识`);
	// name 是 undefined 时已经记过问题，后一个条件只为收窄类型。
	if (problems.length > before || name === undefined) return undefined;
	return { name, enabled: raw.enabled !== false, when, patch };
}

/** 没写名字时按位置叫 `rule-1`、`rule-2`；写了但不是非空文字时返回 undefined。 */
function ruleName(raw: unknown, index: number): string | undefined {
	if (raw === undefined) return `rule-${index + 1}`;
	return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** 读得懂的条件；读不懂的记进 problems。`where` 如 `rules[2]（auth）.when`。 */
function parseWhen(raw: unknown, where: string, problems: string[]): RuleWhen {
	const when: RuleWhen = {};
	if (raw === undefined) return when;
	if (!isRecord(raw)) {
		problems.push(`${where} 需要对象`);
		return when;
	}
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "empty":
				if (value === true) when.empty = true;
				else problems.push(`${where}.empty 只能是 true；不写就是管出错`);
				break;
			case "error":
				if (typeof value !== "string" || !value) {
					problems.push(`${where}.error 需要非空正则字符串`);
					break;
				}
				try {
					when.error = new RegExp(value, "i");
				} catch (error: unknown) {
					problems.push(`${where}.error 不是合法正则（${errorText(error)}）`);
				}
				break;
			case "provider":
			case "model":
				if (typeof value === "string" && value.trim()) when[key] = value.trim();
				else problems.push(`${where}.${key} 需要非空字符串`);
				break;
			default:
				problems.push(`${where}.${key} 不认识`);
		}
	}
	if (raw.empty === true && raw.error !== undefined)
		problems.push(`${where} 里 empty 和 error 不能一起写：空回复没有错误文案`);
	return when;
}
