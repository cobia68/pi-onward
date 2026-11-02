import assert from "node:assert/strict";
import { test } from "node:test";
import { findRule, glob, parseRules } from "../../src/policy/rules.ts";
import { empty, err } from "../support/fake-pi.ts";

const rulesOf = (raw: unknown) => {
	const problems: string[] = [];
	return { rules: parseRules(raw, problems), problems };
};

test("没有内置规则：没写时什么都不命中；不带 when 的规则是显式兜底", () => {
	assert.equal(findRule([], err()), undefined);
	const typo = rulesOf([{ name: "only-401", when: { errr: "401" } }]);
	assert.deepEqual(typo.rules, []);
	assert.deepEqual(typo.problems, ["rules[0]（only-401）.when.errr 不认识"]);
	assert.equal(findRule(rulesOf([{ name: "any", action: "message" }]).rules, err("502"))?.name, "any");
});

test("按顺序第一条命中；没命中的错误不处理；停用的跳过", () => {
	const { rules } = rulesOf([
		{ name: "off", enabled: false, action: "message" },
		{ name: "auth", when: { failure: "401|invalid\\s*api\\s*key" } },
		{ name: "relay", when: { provider: "welfare-*", model: "claude-*" } },
	]);
	assert.equal(findRule(rules, err("401 Invalid API key"))?.name, "auth");
	assert.equal(findRule(rules, err("429 rate limited"))?.name, "relay");
	assert.equal(findRule(rules, err("429 rate limited", { provider: "openai" })), undefined);
	assert.equal(findRule(rules, empty())?.name, "relay", "没有 failure 条件时也匹配空回复");
	assert.equal(findRule(rules, empty({ model: "gpt-test" })), undefined, "各条件必须同时满足");
});

test("failure 统一用正则：^$ 匹配空回复，.+ 匹配普通错误，.* 匹配两者，也能组合", () => {
	const inputs = [err("401 Invalid API key"), empty(), err("502 Bad Gateway"), err("", { errorMessage: undefined })];
	const cases: [string, boolean[]][] = [
		["^$", [false, true, false, false]],
		[".+", [true, false, true, true]],
		[".*", [true, true, true, true]],
		["401|^$", [true, true, false, false]],
	];
	for (const [pattern, expected] of cases) {
		const { rules, problems } = rulesOf([{ name: "match", when: { failure: pattern } }]);
		assert.deepEqual(problems, [], pattern);
		for (const [index, input] of inputs.entries())
			assert.equal(findRule(rules, input) !== undefined, expected[index], `${pattern} / ${index}`);
	}
});

test("省略 failure 不限制失败类型：显式兜底和 provider/model 条件都可以处理空回复", () => {
	for (const when of [undefined, {}]) {
		const { rules, problems } = rulesOf([{ name: "fallback", when, action: "message" }]);
		assert.deepEqual(problems, []);
		assert.equal(findRule(rules, err())?.name, "fallback");
		assert.equal(findRule(rules, empty())?.name, "fallback");
	}
	const { rules } = rulesOf([
		{ name: "relay", when: { failure: "^$", provider: "other-*", model: "claude-*" } },
		{ name: "fallback", action: "message" },
	]);
	assert.equal(findRule(rules, empty({ provider: "other-relay" }))?.name, "relay");
	assert.equal(findRule(rules, empty())?.name, "fallback", "provider 不对就找下一条");
	assert.equal(findRule(rules, err("401", { provider: "other-relay" }))?.name, "fallback", "failure 也要满足");
});

test("普通错误缺少文案时匹配「未知错误」，不冒充空回复；非空文案保持原样", () => {
	const blank = rulesOf([{ when: { failure: "^$" } }]).rules;
	const unknown = rulesOf([{ when: { failure: "^未知错误$" } }]).rules;
	for (const errorMessage of [undefined, "", " \n\t "]) {
		const failure = err("", { errorMessage });
		assert.equal(findRule(blank, failure), undefined, String(errorMessage));
		assert.ok(findRule(unknown, failure), String(errorMessage));
	}
	const { rules, problems } = rulesOf([{ when: { failure: "^ 401  Invalid API KEY\\nrequest id: abc $" } }]);
	assert.deepEqual(problems, []);
	assert.ok(findRule(rules, err(" 401  invalid api key\nrequest id: abc ")), "不裁掉空白，也不归一化 request id");
});

test("failure 没有种类关键字：empty 和 error 都只是普通正则", () => {
	for (const word of ["empty", "error"]) {
		const { rules, problems } = rulesOf([{ when: { failure: word } }]);
		assert.deepEqual(problems, []);
		assert.ok(findRule(rules, err(`upstream ${word} response`)), word);
		assert.equal(findRule(rules, empty()), undefined, word);
	}
});

test("failure 只收非空正则字符串，空字符串不给兜底含义；不兼容 error/empty 字段", () => {
	for (const failure of ["", null, false, 1, [], { error: "401" }]) {
		const { rules, problems } = rulesOf([{ when: { failure } }]);
		assert.deepEqual(rules, [], JSON.stringify(failure));
		assert.match(
			problems.join(),
			/failure 需要非空正则字符串；空回复用 \^\$，所有失败用 \.\*/,
			JSON.stringify(failure),
		);
	}
	for (const when of [{ error: "401" }, { empty: true }]) {
		const { rules, problems } = rulesOf([{ when }]);
		assert.deepEqual(rules, []);
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /when\.(error|empty) 不认识$/);
	}
	const spaces = rulesOf([{ when: { failure: " " } }]);
	assert.deepEqual(spaces.problems, [], "不 trim 正则，空格本身也可以是模式");
	assert.ok(findRule(spaces.rules, err("invalid key")));
	assert.equal(findRule(spaces.rules, empty()), undefined);
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
			when: { failure: "401|invalid api key", provider: "welfare-*" },
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
			when: { failure: /401|invalid api key/i, provider: "welfare-*" },
			patch: { action: "resend", maxRetries: 20, delay: { kind: "ramp", step: 3_000, cap: 10_000 } },
		},
	]);
});

test("读不懂的地方都记下来，一次改完；有一处就不返回这条规则，也不退回默认值", () => {
	const { rules, problems } = rulesOf([
		{ name: "a", when: { failure: "(" } },
		{ name: "b", when: { stopReason: "error" } },
		{ name: "c", when: { provider: "" }, action: "switchModel" },
		// 拼错的键：忽略它的话 action 退回 message，本该停的错误会续跑。
		{ name: "d", when: { failure: "quota" }, acton: "stop" },
		{ name: "e", action: "message", maxRetries: 0 },
		{ name: "f", action: "message", enabled: "false" },
		{ name: "  ", action: "message" },
		{ name: "ok", action: "message" },
		{ name: "ok", action: "message" },
		"nope",
	]);
	assert.deepEqual(
		rules.map((r) => r.name),
		["ok"],
	);
	assert.match(problems[0]!, /^rules\[0\]（a）\.when\.failure 不是合法正则/);
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
		rulesOf([{ action: "message" }, { enabled: false, action: "message" }]).rules.map((r) => [r.name, r.enabled]),
		[
			["rule-1", true],
			["rule-2", false],
		],
	);
	assert.deepEqual(rulesOf({}).problems, ["rules 需要数组"]);
});
