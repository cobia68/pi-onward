/** First matching rule wins. Within it, select the last stage whose inclusive threshold has been reached. */
import { ACTION_NAME_PATTERN, type ActionCall } from "../actions/protocol.ts";
import { errorText, isRecord } from "../util.ts";
import { type Delay, parseDelay } from "./delay.ts";
import { type Failure, failureText } from "./failure.ts";

export interface RuleWhen {
	failure?: RegExp;
	provider?: string;
	model?: string;
}
export interface Stage {
	minFailures: number;
	delay: Delay;
	action: ActionCall;
}
export interface Rule {
	name: string;
	enabled: boolean;
	when: RuleWhen;
	stages: Stage[];
}
export const RULE_KEYS = new Set(["name", "enabled", "when", "stages"]);
export function findRule(rules: readonly Rule[], failure: Failure): Rule | undefined {
	return rules.find((rule) => rule.enabled && matches(rule.when, failure));
}
function matches(when: RuleWhen, failure: Failure): boolean {
	return (
		(when.failure === undefined || when.failure.test(failureText(failure))) &&
		(when.provider === undefined || glob(when.provider, failure.provider)) &&
		(when.model === undefined || glob(when.model, failure.model))
	);
}
export function glob(pattern: string, value: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i").test(value);
}
export function selectStage(rule: Rule, failures: number): Stage {
	for (let index = rule.stages.length - 1; index >= 0; index--) {
		const stage = rule.stages[index]!;
		if (stage.minFailures <= failures) return stage;
	}
	throw new Error("No recovery stage covers the current failure count");
}
export function ruleWarnings(rules: readonly Rule[]): string[] {
	let fallback: string | undefined;
	const warnings: string[] = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (fallback)
			warnings.push(`Rule "${rule.name}" is shadowed by earlier catch-all rule "${fallback}" and cannot match`);
		if (!fallback && !Object.keys(rule.when).length) fallback = rule.name;
	}
	return warnings;
}
export function parseRules(raw: unknown, problems: string[]): Rule[] {
	if (!Array.isArray(raw)) {
		problems.push("rules must be an array");
		return [];
	}
	const rules: Rule[] = [];
	for (const [index, value] of raw.entries()) {
		const label = `rules[${index}]`;
		if (!isRecord(value)) {
			problems.push(`${label} must be an object`);
			continue;
		}
		const before = problems.length;
		unknownKeys(value, RULE_KEYS, label, problems);
		const name = value.name === undefined ? `rule-${index + 1}` : value.name;
		if (typeof name !== "string" || !name.trim()) problems.push(`${label}.name must be a non-empty string`);
		if (value.enabled !== undefined && typeof value.enabled !== "boolean")
			problems.push(`${label}.enabled must be true or false`);
		const when = parseWhen(value.when, `${label}.when`, problems);
		const stages = parseStages(value.stages, `${label}.stages`, problems);
		if (problems.length !== before || typeof name !== "string") continue;
		if (rules.some((rule) => rule.name === name.trim()))
			problems.push(`${label}.name duplicates an earlier rule name`);
		else rules.push({ name: name.trim(), enabled: value.enabled !== false, when, stages });
	}
	return rules;
}
function parseStages(raw: unknown, label: string, problems: string[]): Stage[] {
	if (!Array.isArray(raw) || !raw.length) {
		problems.push(`${label} must be a non-empty array`);
		return [];
	}
	const stages: Stage[] = [];
	let previous = 0;
	for (const [index, value] of raw.entries()) {
		const at = `${label}[${index}]`;
		if (!isRecord(value)) {
			problems.push(`${at} must be an object`);
			continue;
		}
		const before = problems.length;
		unknownKeys(value, new Set(["minFailures", "delay", "action"]), at, problems);
		const minFailures = value.minFailures;
		if (!Number.isSafeInteger(minFailures) || (minFailures as number) < 1 || (minFailures as number) > 1000)
			problems.push(`${at}.minFailures must be an integer between 1 and 1000`);
		else {
			if (index === 0 && minFailures !== 1) problems.push(`${at}.minFailures must be 1 for the first stage`);
			if ((minFailures as number) <= previous) problems.push(`${at}.minFailures must be strictly increasing`);
			previous = minFailures as number;
		}
		const delay =
			value.delay === undefined
				? parseDelay("0s")
				: typeof value.delay === "string"
					? parseDelay(value.delay)
					: "must be a delay string with units";
		if (typeof delay === "string") problems.push(`${at}.delay ${delay}`);
		const action = value.action;
		if (!isRecord(action)) {
			problems.push(`${at}.action must be an object with "use" and optional "with"`);
			continue;
		}
		unknownKeys(action, new Set(["use", "with"]), `${at}.action`, problems);
		if (typeof action.use !== "string" || !new RegExp(ACTION_NAME_PATTERN).test(action.use))
			problems.push(`${at}.action.use must be a qualified action name such as pi.message`);
		if (action.with !== undefined && !isRecord(action.with)) problems.push(`${at}.action.with must be an object`);
		if (problems.length === before && typeof delay !== "string")
			stages.push({
				minFailures: minFailures as number,
				delay,
				action: {
					use: action.use as string,
					...(action.with === undefined ? {} : { with: structuredClone(action.with) as Record<string, unknown> }),
				},
			});
	}
	return stages;
}
function parseWhen(raw: unknown, label: string, problems: string[]): RuleWhen {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		problems.push(`${label} must be an object`);
		return {};
	}
	const when: RuleWhen = {};
	unknownKeys(raw, new Set(["failure", "provider", "model"]), label, problems);
	for (const key of ["failure", "provider", "model"] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !value.trim()) {
			problems.push(`${label}.${key} must be a non-empty string`);
			continue;
		}
		if (key !== "failure") when[key] = value.trim();
		else {
			try {
				when.failure = new RegExp(value, "i");
			} catch (error) {
				problems.push(`${label}.failure is not a valid regular expression (${errorText(error)})`);
			}
		}
	}
	return when;
}
export function unknownKeys(
	raw: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
	problems: string[],
): void {
	for (const key of Object.keys(raw))
		if (!allowed.has(key)) problems.push(`${label ? `${label}.` : ""}${key} is not a recognized field`);
}
