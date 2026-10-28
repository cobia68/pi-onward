/**
 * 设置文件的模型：顶层写的参数就是每条规则的默认值，规则里同名的字段覆盖它。
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "action": "message", "maxRetries": 10,
 *   "rules": [{ "name": "auth", "when": { "error": "401" }, "action": "resend", "maxRetries": 20 }]
 * }
 * ```
 */
import { isRecord } from "../util.ts";
import { type Failure, isFailure } from "./failure.ts";
import { FIELD_NAMES, type Policy, type PolicyPatch, readParams, resolvePolicy } from "./policy.ts";
import { findRule, parseRules, type Rule } from "./rules.ts";

export interface Config {
	enabled: boolean;
	/** 顶层的参数：规则没写的字段用它。 */
	defaults: PolicyPatch;
	rules: Rule[];
	/** 校验时丢掉或忽略的内容，给 `/onward show` 看。 */
	problems: string[];
}

const CONFIG_KEYS = new Set(["$schema", "enabled", "rules", ...FIELD_NAMES]);

/** 坏掉的部分丢掉并记问题，不抛。 */
export function parseConfig(raw: unknown): Config {
	if (raw === undefined || raw === null) return emptyConfig();
	if (!isRecord(raw)) return emptyConfig(["设置文件不是对象，已忽略"]);
	const problems: string[] = [];
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("enabled 需要 true 或 false");
	const defaults = readParams(raw, problems);
	const rules = parseRules(raw.rules, problems);
	for (const key of Object.keys(raw)) if (!CONFIG_KEYS.has(key)) problems.push(`${key} 不认识，已忽略`);
	return { enabled: raw.enabled !== false, defaults, rules, problems };
}

/** 写回设置文件时的键顺序：`$schema`、`enabled`、参数、其他、`rules`。 */
export function fileOrder(raw: Record<string, unknown>): Record<string, unknown> {
	const first = ["$schema", "enabled", ...FIELD_NAMES];
	const keys = [
		...first.filter((key) => key in raw),
		...Object.keys(raw).filter((key) => !first.includes(key) && key !== "rules"),
		...("rules" in raw ? ["rules"] : []),
	];
	return Object.fromEntries(keys.map((key) => [key, raw[key]]));
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
