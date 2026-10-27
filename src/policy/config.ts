/**
 * 设置文件的模型：
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "defaults": { "mode": "message", "maxRetries": 10 },   // 规则没写的参数用它
 *   "rules": [{ "name": "auth", "when": { "match": "401" }, "then": { "mode": "silent" }, "budget": { "maxRetries": 20 } }]
 * }
 * ```
 */
import { isRecord } from "../util.ts";
import { type Failure, isFailure } from "./failure.ts";
import { type Policy, type PolicyPatch, parsePolicyPatch, resolvePolicy } from "./policy.ts";
import { findRule, parseRules, type Rule } from "./rules.ts";

export interface Config {
	enabled: boolean;
	defaults: PolicyPatch;
	rules: Rule[];
	/** 校验时丢掉或忽略的内容，给 `/onward rules` 看。 */
	problems: string[];
}

const CONFIG_KEYS = new Set(["$schema", "enabled", "defaults", "rules"]);

/** 坏掉的部分丢掉并记问题，不抛。 */
export function parseConfig(raw: unknown): Config {
	if (raw === undefined || raw === null) return emptyConfig();
	if (!isRecord(raw)) return emptyConfig(["设置文件不是对象，已忽略"]);
	const problems: string[] = [];
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("enabled 需要 true 或 false");
	const defaults = parsePolicyPatch(raw.defaults, "defaults", problems);
	const rules = parseRules(raw.rules, problems);
	for (const key of Object.keys(raw)) if (!CONFIG_KEYS.has(key)) problems.push(`${key} 不认识，已忽略`);
	return { enabled: raw.enabled !== false, defaults, rules, problems };
}

/** 旧版 `auto-continue.json` 是扁平字段，除 enabled 外都当 defaults。只迁参数，不替它生成规则。 */
export function migrateLegacy(raw: unknown): Config {
	if (!isRecord(raw)) return emptyConfig(["旧设置文件不是对象，已忽略"]);
	const { enabled, ...rest } = raw;
	const problems: string[] = [];
	const defaults = parsePolicyPatch(rest, "auto-continue.json", problems);
	return { enabled: enabled !== false, defaults, rules: [], problems };
}

/** 一次失败命中了哪条规则，按什么参数处理。 */
export interface Hit {
	rule: Rule;
	policy: Policy;
	failure: Failure;
}

export function matchFailure(config: Config, message: unknown): Hit | undefined {
	if (!config.enabled || !isFailure(message)) return undefined;
	const rule = findRule(config.rules, message);
	return rule && { rule, policy: resolvePolicy(config.defaults, rule.patch), failure: message };
}

function emptyConfig(problems: string[] = []): Config {
	return { enabled: true, defaults: {}, rules: [], problems };
}
