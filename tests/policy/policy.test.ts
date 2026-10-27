import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, parsePolicyPatch, renderPrompt, resolvePolicy } from "../../src/policy/policy.ts";

test("默认参数：发「继续」，最多 10 次，同错 10 次", () => {
	assert.deepEqual(resolvePolicy({}), DEFAULT_POLICY);
	assert.equal(DEFAULT_POLICY.prompt, "继续");
	assert.equal(DEFAULT_POLICY.maxRetries, 10);
	assert.equal(DEFAULT_POLICY.sameErrorLimit, 10);
});

test("内置默认值 ← defaults ← 规则参数", () => {
	const policy = resolvePolicy({ maxRetries: 3, mode: "silent" }, { maxRetries: 20 });
	assert.equal(policy.maxRetries, 20);
	assert.equal(policy.mode, "silent");
	assert.equal(policy.prompt, "继续");
});

test("参数夹到范围内，坏值和不认识的键丢掉并记问题", () => {
	const problems: string[] = [];
	const patch = parsePolicyPatch(
		{
			maxRetries: 999,
			sameErrorLimit: 0,
			retryDelaysMs: [1, 9e9, "x"],
			mode: "loud",
			prompt: "x".repeat(600),
			colour: "red",
		},
		"defaults",
		problems,
	);
	assert.deepEqual(patch, {
		maxRetries: 50,
		sameErrorLimit: 1,
		retryDelaysMs: [1, 3_600_000],
		prompt: "x".repeat(500),
	});
	assert.deepEqual(problems, ["defaults.mode 只能是 message 或 silent", "defaults.colour 不认识，已忽略"]);
	assert.deepEqual(parsePolicyPatch("nope", "defaults", problems), {});
	assert.equal(problems.at(-1), "defaults 不是对象，已忽略");
	assert.deepEqual(parsePolicyPatch({ constructor: 1 }, "x"), {}, "原型上的键不算认识");
});

test("提示词模板：不认识的占位原样留着", () => {
	assert.equal(
		renderPrompt("第 {attempt}/{max} 次（{rule}）：{error} {unknown}", {
			attempt: 2,
			max: 10,
			error: "401 x",
			rule: "auth",
		}),
		"第 2/10 次（auth）：401 x {unknown}",
	);
});
