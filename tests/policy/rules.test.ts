import assert from "node:assert/strict";
import { test } from "node:test";
import { findRule, glob, parseRules, ruleWarnings, selectStage } from "../../src/policy/rules.ts";
import { empty, err, rule, stage } from "../support/fake-pi.ts";

function parse(raw: unknown) {
	const problems: string[] = [];
	const rules = parseRules(raw, problems);
	return { rules, problems };
}

test("minFailures 包含当前失败，每次只选择已达到下限的最后一个阶段", () => {
	const result = parse([
		{
			stages: [
				{ minFailures: 1, action: { use: "pi.message" } },
				{ minFailures: 3, action: { use: "respawn.restart" } },
				{ minFailures: 5, action: { use: "onward.stop" } },
			],
		},
	]);
	assert.deepEqual(result.problems, []);
	assert.throws(() => selectStage(result.rules[0]!, 0), /No recovery stage covers the current failure count/);
	const selected = [1, 2, 3, 4, 5, 20].map((n) => selectStage(result.rules[0]!, n));
	assert.deepEqual(
		selected.map((stage) => stage.minFailures),
		[1, 1, 3, 3, 5, 5],
	);
	assert.deepEqual(
		selected.map((stage) => stage.action.use),
		["pi.message", "pi.message", "respawn.restart", "respawn.restart", "onward.stop", "onward.stop"],
	);
});
test("第一阶段必须从 1 开始、阈值严格递增、动作仅接受 use/with", () => {
	for (const stages of [
		[],
		[stage(2)],
		[stage(), stage(1)],
		[stage(), stage(4), stage(3)],
		[stage(0)],
		[stage(1.5)],
		[{ minFailures: 1, action: "resend" }],
		[stage(1, "bad")],
		[{ ...stage(), delay: "x" }],
		[{ minFailures: 1, action: { use: "pi.message", with: [] } }],
	]) {
		const result = parse([{ stages }]);
		assert.ok(result.problems.length, JSON.stringify(stages));
		assert.doesNotMatch(result.problems.join("\n"), /\p{Script=Han}/u);
		assert.deepEqual(result.rules, []);
	}
	assert.ok(parse([{ action: "resend", maxRetries: 3 }]).problems.length);
});
test("规则按顺序匹配，停用规则跳过，失败/供应商/模型条件取交集", () => {
	const { rules, problems } = parse([
		{ ...rule([stage(1, "onward.stop")], "disabled"), enabled: false },
		{ ...rule([stage()], "auth"), when: { failure: "401", provider: "TEST-*", model: "test-model" } },
		rule([stage(1, "pi.message")], "fallback"),
	]);
	assert.deepEqual(problems, []);
	assert.equal(findRule(rules, err("401"))?.name, "auth");
	assert.equal(findRule(rules, err("401", { provider: "other" }))?.name, "fallback");
	assert.equal(findRule(rules, empty())?.name, "fallback");
});
test("失败正则保留空回复、缺少错误文案及原始错误文本的含义", () => {
	for (const [pattern, matchesError, matchesEmpty] of [
		["^$", false, true],
		[".+", true, false],
		[".*", true, true],
		["401|^$", true, true],
	] as const) {
		const { rules } = parse([{ ...rule(), when: { failure: pattern } }]);
		assert.equal(!!findRule(rules, err("401")), matchesError);
		assert.equal(!!findRule(rules, empty()), matchesEmpty);
	}
	const { rules } = parse([{ ...rule(), when: { failure: "^未知错误$" } }]);
	assert.ok(findRule(rules, err("")));
	assert.equal(findRule(rules, empty()), undefined);
});
test("未知键、坏正则、空条件、重名都严格拒绝", () => {
	for (const value of [
		{ ...rule(), when: { failure: "" } },
		{ ...rule(), when: { failure: "[" } },
		{ ...rule(), when: { error: "401" } },
		{ ...rule(), unexpected: true },
		{ ...rule(), enabled: "yes" },
		{ ...rule(), name: " " },
	]) {
		const { problems } = parse([value]);
		assert.ok(problems.length);
		assert.doesNotMatch(problems.join("\n"), /\p{Script=Han}/u);
	}
	assert.ok(parse([rule(), rule()]).problems.some((text) => text.includes("duplicates an earlier rule name")));
	assert.ok(parse({}).problems.length);
});
test("只有 * 是整串通配；兜底遮挡是独立提醒", () => {
	assert.equal(glob("a.*", "A.X"), true);
	assert.equal(glob("a.*", "abc"), false);
	assert.equal(glob("test", "test-extra"), false);
	const { rules } = parse([rule(), { ...rule([stage()], "later"), when: { failure: "401" } }]);
	assert.deepEqual(ruleWarnings(rules), [
		'Rule "later" is shadowed by earlier catch-all rule "server" and cannot match',
	]);
});
