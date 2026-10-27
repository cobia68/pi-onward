/**
 * 规则 = 条件（when）+ 动作（then）+ 预算（budget），按顺序第一条命中的生效。
 * 没有内置规则：没写、全部写坏或没命中，都不处理。
 */
import { errorText, isRecord } from "../util.ts";
import type { Failure } from "./failure.ts";
import { type PolicyPatch, parsePolicyPatch } from "./policy.ts";

export interface RuleWhen {
	/** 正则，大小写不敏感，对原始错误文案匹配。 */
	match?: string;
	/** 通配，只有 `*` 有特殊含义。 */
	provider?: string;
	model?: string;
}

export interface Rule {
	name: string;
	enabled: boolean;
	when: RuleWhen;
	/** then 与 budget 合并后的参数，只覆盖写了的字段。 */
	patch: PolicyPatch;
}

const MAX_RULES = 50;
const MAX_NAME = 40;
const RULE_KEYS = new Set(["name", "enabled", "when", "then", "budget"]);

export function findRule(rules: readonly Rule[], failure: Failure): Rule | undefined {
	return rules.find((rule) => rule.enabled && matches(rule.when, failure));
}

function matches(when: RuleWhen, failure: Failure): boolean {
	if (when.match !== undefined && !new RegExp(when.match, "i").test(failure.errorMessage ?? "")) return false;
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

/**
 * 看不懂的条件或动作整条丢掉：忽略一个条件会让规则匹配得更宽，多发真实请求。
 * 看不懂的参数只忽略那一项：最多退回默认值。
 */
function parseRule(raw: unknown, index: number, problems: string[]): Rule | undefined {
	const where = `rules[${index}]`;
	if (!isRecord(raw)) {
		problems.push(`${where} 不是对象，已丢弃`);
		return undefined;
	}
	const name =
		typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME) : `rule-${index + 1}`;
	const label = `${where}（${name}）`;
	const when = parseWhen(raw.when);
	const params = parseThen(raw.then);
	if (typeof when === "string" || typeof params === "string") {
		problems.push(`${label}.${typeof when === "string" ? when : params}，已丢弃`);
		return undefined;
	}
	const patch = {
		...parsePolicyPatch(params, `${label}.then`, problems),
		...parsePolicyPatch(raw.budget, `${label}.budget`, problems),
	};
	for (const key of Object.keys(raw)) if (!RULE_KEYS.has(key)) problems.push(`${label}.${key} 不认识，已忽略`);
	return { name, enabled: raw.enabled !== false, when, patch };
}

/** 合法时返回条件，否则返回原因。 */
function parseWhen(raw: unknown): RuleWhen | string {
	if (raw === undefined) return {};
	if (!isRecord(raw)) return "when 不是对象";
	const when: RuleWhen = {};
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			// 失败本来就只有 error 一种；先占住字段，以后支持 length 之类再放开。
			case "stopReason":
				if (value !== "error") return `when.stopReason 目前只支持 "error"`;
				break;
			case "match": {
				if (typeof value !== "string" || !value) return "when.match 需要非空正则字符串";
				const invalid = regexError(value);
				if (invalid) return `when.match 不是合法正则（${invalid}）`;
				when.match = value;
				break;
			}
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

/** 合法时返回动作以外的参数，否则返回原因。 */
function parseThen(raw: unknown): Record<string, unknown> | string {
	if (raw === undefined) return {};
	if (!isRecord(raw)) return "then 不是对象";
	const { action = "continue", ...params } = raw;
	return action === "continue" ? params : `then.action 目前只支持 "continue"`;
}

function regexError(source: string): string | undefined {
	try {
		new RegExp(source, "i");
		return undefined;
	} catch (error: unknown) {
		return errorText(error);
	}
}
