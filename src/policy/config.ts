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
 *
 * 读不懂的内容（拼错的键、超出范围的值、重名的规则）都记成问题。有问题时整份设置不生效，修好之前
 * 不会自动续跑：丢掉一部分、其余照跑，会让错误落到更宽的规则或默认值上，多发真实请求。
 */
import { type AgentMessage, type Failure, isFailure } from "./failure.ts";
import { FIELD_NAMES, type Policy, type PolicyPatch, readParams, resolvePolicy } from "./policy.ts";
import { findRule, parseRules, type Rule } from "./rules.ts";

export interface Config {
	enabled: boolean;
	/** 顶层的参数：规则没写的字段用它。 */
	defaults: PolicyPatch;
	rules: Rule[];
	/** 读不懂的内容；不为空时整份设置不生效。 */
	problems: string[];
}

const CONFIG_KEYS = new Set(["$schema", "enabled", "rules", ...FIELD_NAMES]);

/** `raw` 是设置文件的内容，undefined 表示没有设置文件。不抛，读不懂的记进 problems。 */
export function parseConfig(raw: Record<string, unknown> | undefined): Config {
	if (raw === undefined) return { enabled: true, defaults: {}, rules: [], problems: [] };
	const problems: string[] = [];
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("enabled 需要 true 或 false");
	const defaults = readParams(raw, "", problems);
	for (const key of Object.keys(raw)) if (!CONFIG_KEYS.has(key)) problems.push(`${key} 不认识`);
	const rules = parseRules(raw.rules, problems);
	return { enabled: raw.enabled !== false, defaults, rules, problems };
}

/** 开着，并且设置里没有读不懂的内容。 */
export function isActive(config: Config): boolean {
	return config.enabled && config.problems.length === 0;
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

export function matchFailure(config: Config, message: AgentMessage | undefined): Hit | undefined {
	if (!isActive(config) || !isFailure(message)) return undefined;
	const rule = findRule(config.rules, message);
	return rule && { rule, policy: resolvePolicy(config.defaults, rule.patch), failure: message };
}
