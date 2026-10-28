import assert from "node:assert/strict";
import { test } from "node:test";
import { findRule, glob, parseRules } from "../../src/policy/rules.ts";
import { err } from "../support/fake-pi.ts";

const rulesOf = (raw: unknown) => {
	const problems: string[] = [];
	return { rules: parseRules(raw, problems), problems };
};

test("没有内置规则：没写或全部写坏时什么都不命中", () => {
	assert.equal(findRule([], err()), undefined);
	const typo = rulesOf([{ name: "only-401", when: { errr: "401" } }]);
	assert.deepEqual(typo.rules, []);
	assert.equal(findRule(typo.rules, err("429 rate limited")), undefined);
	assert.equal(findRule(rulesOf([{ name: "any" }]).rules, err("502"))?.name, "any", "不带 when 的规则是显式兜底");
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
	assert.equal(glob("*", undefined), false);
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

test("看不懂的条件或动作整条丢掉，不让它匹配得更宽；看不懂的参数只忽略那一项", () => {
	const { rules, problems } = rulesOf([
		{ name: "a", when: { error: "(" } },
		{ name: "b", when: { stopReason: "error" } },
		{ name: "c", when: { tool: "bash" } },
		{ name: "d", action: "switchModel" },
		{ name: "e", when: { provider: "" } },
		{ name: "ok", extra: 1, colour: "red", maxRetries: 0 },
		{ name: "ok" },
		"nope",
	]);
	assert.deepEqual(
		rules.map((r) => [r.name, r.patch]),
		[["ok", {}]],
	);
	for (const marker of ["rules[0]", "rules[1]", "rules[2]", "rules[3]", "rules[4]", "rules[6]", "rules[7]"])
		assert.ok(
			problems.some((p) => p.startsWith(marker)),
			`${marker} 应记问题：${problems.join(" | ")}`,
		);
	assert.ok(problems.includes("rules[3]（d）.action 只能是 message、resend 或 stop，已丢弃"));
	assert.ok(problems.includes("rules[5]（ok）.maxRetries 需要 1–50 的整数，已忽略"));
	assert.ok(problems.includes("rules[5]（ok）.extra 不认识，已忽略"));
	assert.ok(problems.includes("rules[5]（ok）.colour 不认识，已忽略"));
});

test("没名字的规则按位置起名；enabled=false 保留但停用；rules 不是数组时忽略", () => {
	assert.deepEqual(
		rulesOf([{}, { enabled: false }]).rules.map((r) => [r.name, r.enabled]),
		[
			["rule-1", true],
			["rule-2", false],
		],
	);
	assert.deepEqual(rulesOf({}).problems, ["rules 需要数组，已忽略"]);
});
