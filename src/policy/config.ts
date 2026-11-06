/** Global then project settings. Rules replace as a whole; malformed layers never partially activate. */
import { type AgentMessage, type Failure, isFailure } from "./failure.ts";
import { FIELD_NAMES, type Limits, type LimitsPatch, readLimits, resolveLimits } from "./policy.ts";
import { findRule, parseRules, type Rule, ruleWarnings, type Stage, selectStage, unknownKeys } from "./rules.ts";

export interface Config {
	enabled: boolean;
	quietStartup?: boolean;
	limits: LimitsPatch;
	rules: Rule[];
	problems: string[];
}
export interface ConfigLayer {
	enabled?: boolean;
	quietStartup?: boolean;
	limits: LimitsPatch;
	rules?: Rule[];
	problems: string[];
}
export const CONFIG_KEYS = new Set(["$schema", "enabled", "quietStartup", "rules", ...FIELD_NAMES]);
export function parseLayer(raw: Record<string, unknown>, project = false): ConfigLayer {
	const problems: string[] = [];
	unknownKeys(raw, CONFIG_KEYS, "", problems);
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("enabled must be true or false");
	if (raw.quietStartup !== undefined) {
		if (project) problems.push("quietStartup is only allowed in global settings");
		else if (typeof raw.quietStartup !== "boolean") problems.push("quietStartup must be true or false");
	}
	const limits = readLimits(raw, problems);
	const rules = raw.rules === undefined ? undefined : parseRules(raw.rules, problems);
	return {
		...(typeof raw.enabled === "boolean" && { enabled: raw.enabled }),
		...(!project && typeof raw.quietStartup === "boolean" && { quietStartup: raw.quietStartup }),
		limits,
		...(rules && { rules }),
		problems,
	};
}
export function mergeLayers(layers: readonly ConfigLayer[]): Config {
	const config: Config = { enabled: true, limits: {}, rules: [], problems: [] };
	for (const layer of layers) {
		if (layer.enabled !== undefined) config.enabled = layer.enabled;
		if (layer.quietStartup !== undefined) config.quietStartup = layer.quietStartup;
		Object.assign(config.limits, layer.limits);
		if (layer.rules !== undefined) config.rules = layer.rules;
		config.problems.push(...layer.problems);
	}
	return config;
}
export const isActive = (config: Config): boolean => config.enabled && !config.problems.length;
export const configWarnings = (config: Config): string[] => (config.problems.length ? [] : ruleWarnings(config.rules));
export function fileOrder(raw: Record<string, unknown>): Record<string, unknown> {
	const first = ["$schema", "enabled", ...FIELD_NAMES, "quietStartup"];
	return Object.fromEntries(
		[
			...first.filter((key) => key in raw),
			...Object.keys(raw).filter((key) => !first.includes(key) && key !== "rules"),
			...("rules" in raw ? ["rules"] : []),
		].map((key) => [key, raw[key]]),
	);
}
export interface Hit {
	rule: Rule;
	stage: Stage;
	failure: Failure;
	limits: Limits;
}
export function matchFailure(config: Config, message: AgentMessage | undefined, failures: number): Hit | undefined {
	if (!isActive(config) || !isFailure(message)) return undefined;
	const rule = findRule(config.rules, message);
	return rule && { rule, stage: selectStage(rule, failures), failure: message, limits: resolveLimits(config.limits) };
}
