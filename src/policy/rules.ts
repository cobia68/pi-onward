/**
 * 规则 = 条件（when）+ 参数，按顺序第一条命中的生效。参数和设置文件顶层同名，只写和顶层不同的。
 * 没有内置规则：没写、全部写坏或没命中，都不处理。
 */
import { errorText, isRecord } from "../util.ts";
import type { Failure } from "./failure.ts";
import { FIELD_NAMES, type PolicyPatch, readRuleParams } from "./policy.ts";

export interface RuleWhen {
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

const MAX_RULES = 50;
const MAX_NAME = 40;
const RULE_KEYS = new Set(["name", "enabled", "when", ...FIELD_NAMES]);

export function findRule(rules: readonly Rule[], failure: Failure): Rule | undefined {
	return rules.find((rule) => rule.enabled && matches(rule.when, failure));
}

function matches(when: RuleWhen, failure: Failure): boolean {
	if (when.error !== undefined && !when.error.test(failure.errorMessage ?? "")) return false;
	if (when.provider !== undefined && !glob(when.provider, failure.provider)) return false;
	if (when.model !== undefined && !glob(when.model, failure.model)) return false;
	return true;
}

/** 大小写不敏感，整串匹配。 */
export function glob(pattern: string, value: string | undefined): boolean {
	if (value === undefined) return false;
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i").test(value);
}

/** 校验规则列表；坏掉和重名的规则丢掉并记问题。 */
export function parseRules(raw: unknown, problems: string[]): Rule[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		problems.push("rules 需要数组，已忽略");
		return [];
	}
	if (raw.length > MAX_RULES) problems.push(`rules 超过 ${MAX_RULES} 条，多出的已忽略`);
	const rules: Rule[] = [];
	for (const [index, item] of raw.slice(0, MAX_RULES).entries()) {
		const rule = parseRule(item, index, problems);
		if (!rule) continue;
		if (rules.some((r) => r.name === rule.name))
			problems.push(`rules[${index}] 与前面的规则重名（${rule.name}），已丢弃`);
		else rules.push(rule);
	}
	return rules;
}

function ruleLabel(raw: Record<string, unknown>, index: number): string {
	return `rules[${index}]（${ruleName(raw, index)}）`;
}

function ruleName(raw: Record<string, unknown>, index: number): string {
	return typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME) : `rule-${index + 1}`;
}

/** 看不懂的条件整条丢掉：忽略一个条件会让规则匹配得更宽。参数怎么处理见 readRuleParams。 */
function parseRule(raw: unknown, index: number, problems: string[]): Rule | undefined {
	if (!isRecord(raw)) {
		problems.push(`rules[${index}] 不是对象，已丢弃`);
		return undefined;
	}
	const label = ruleLabel(raw, index);
	const when = parseWhen(raw.when);
	if (typeof when === "string") {
		problems.push(`${label}.${when}，已丢弃`);
		return undefined;
	}
	const patch = readRuleParams(raw, `${label}.`, problems);
	if (!patch) return undefined;
	for (const key of Object.keys(raw)) if (!RULE_KEYS.has(key)) problems.push(`${label}.${key} 不认识，已忽略`);
	return { name: ruleName(raw, index), enabled: raw.enabled !== false, when, patch };
}

/** 合法时返回条件，否则返回原因。 */
function parseWhen(raw: unknown): RuleWhen | string {
	if (raw === undefined) return {};
	if (!isRecord(raw)) return "when 不是对象";
	const when: RuleWhen = {};
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "error":
				if (typeof value !== "string" || !value) return "when.error 需要非空正则字符串";
				try {
					when.error = new RegExp(value, "i");
				} catch (error: unknown) {
					return `when.error 不是合法正则（${errorText(error)}）`;
				}
				break;
			case "provider":
			case "model":
				if (typeof value !== "string" || !value.trim()) return `when.${key} 需要非空字符串`;
				when[key] = value.trim();
				break;
			default:
				return `when.${key} 不认识`;
		}
	}
	return when;
}
