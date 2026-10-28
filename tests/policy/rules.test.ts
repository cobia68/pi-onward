import assert from "node:assert/strict";
import { test } from "node:test";
import { findRule, glob, parseRules } from "../../src/policy/rules.ts";
import { err } from "../support/fake-pi.ts";

const rulesOf = (raw: unknown) => {
	const problems: string[] = [];
	return { rules: parseRules(raw, problems), problems };
};

test("没有内置规则：没写时什么都不命中；不带 when 的规则是显式兜底", () => {
	assert.equal(findRule([], err()), undefined);
	const typo = rulesOf([{ name: "only-401", when: { errr: "401" } }]);
	assert.deepEqual(typo.rules, []);
	assert.deepEqual(typo.problems, ["rules[0]（only-401）.when.errr 不认识"]);
	assert.equal(findRule(rulesOf([{ name: "any" }]).rules, err("502"))?.name, "any");
});

test("按顺序第一条命中；没命中的错误不处理；停用的跳过", () => {
	const { rules } = rulesOf([
		{ name: "off", enabled: false },
		{ name: "auth", when: { error: "401|invalid\\s*api\\s*key" } },
		{ name: "relay", when: { provider: "welfare-*", model: "claude-*" } },
	]);
	assert.equal(findRule(rules, err("401 Invalid API key"))?.name, "auth");
	assert.equal(findRule(rules, err("429 rate limited"))?.name, "relay");
	assert.equal(findRule(rules, err("429 rate limited", { provider: "openai" })), undefined);
});

test("通配只认 *，大小写不敏感，整串匹配", () => {
	assert.equal(glob("welfare-*", "Welfare-K40"), true);
	assert.equal(glob("welfare-*", "x-welfare-k40"), false);
	assert.equal(glob("a.b", "aXb"), false);
});

test("规则的参数和顶层同名，平铺在规则里", () => {
	const { rules, problems } = rulesOf([
		{
			name: "relay",
			when: { error: "401|invalid api key", provider: "welfare-*" },
			action: "resend",
			maxRetries: 20,
			delay: "3s..10s",
		},
	]);
	assert.deepEqual(problems, []);
	assert.deepEqual(rules, [
		{
			name: "relay",
			enabled: true,
			when: { error: /401|invalid api key/i, provider: "welfare-*" },
			patch: { action: "resend", maxRetries: 20, delay: { kind: "ramp", step: 3_000, cap: 10_000 } },
		},
	]);
});

test("读不懂的地方都记下来，一次改完；有一处就不返回这条规则，也不退回默认值", () => {
	const { rules, problems } = rulesOf([
		{ name: "a", when: { error: "(" } },
		{ name: "b", when: { stopReason: "error" } },
		{ name: "c", when: { provider: "" }, action: "switchModel" },
		// 拼错的键：忽略它的话 action 退回 message，本该停的错误会续跑。
		{ name: "d", when: { error: "quota" }, acton: "stop" },
		{ name: "e", maxRetries: 0 },
		{ name: "f", enabled: "false" },
		{ name: "  " },
		{ name: "ok" },
		{ name: "ok" },
		"nope",
	]);
	assert.deepEqual(
		rules.map((r) => r.name),
		["ok"],
	);
	assert.match(problems[0]!, /^rules\[0\]（a）\.when\.error 不是合法正则/);
	assert.deepEqual(problems.slice(1), [
		"rules[1]（b）.when.stopReason 不认识",
		"rules[2]（c）.when.provider 需要非空字符串",
		"rules[2]（c）.action 只能是 message、resend 或 stop",
		"rules[3]（d）.acton 不认识",
		"rules[4]（e）.maxRetries 需要 1–50 的整数",
		"rules[5]（f）.enabled 需要 true 或 false",
		"rules[6].name 需要非空文字",
		"rules[8] 与前面的规则重名（ok）",
		"rules[9] 不是对象",
	]);
});

test("没名字的规则按位置起名；enabled=false 保留但停用；rules 不是数组时记问题", () => {
	assert.deepEqual(
		rulesOf([{}, { enabled: false }]).rules.map((r) => [r.name, r.enabled]),
		[
			["rule-1", true],
			["rule-2", false],
		],
	);
	assert.deepEqual(rulesOf({}).problems, ["rules 需要数组"]);
});
