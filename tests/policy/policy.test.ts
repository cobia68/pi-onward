import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, readParams, readRuleParams, renderPrompt, resolvePolicy } from "../../src/policy/policy.ts";

test("内置默认值：发「继续」，最多 10 次，同一个错误最多 10 次，3s..15s", () => {
	assert.deepEqual(resolvePolicy({}), DEFAULT_POLICY);
	assert.equal(DEFAULT_POLICY.action, "message");
	assert.equal(DEFAULT_POLICY.prompt, "继续");
	assert.equal(DEFAULT_POLICY.maxRetries, 10);
	assert.equal(DEFAULT_POLICY.maxSameError, 10);
	assert.deepEqual(DEFAULT_POLICY.delay, { kind: "ramp", step: 3_000, cap: 15_000 });
});

test("内置默认值 ← 顶层 ← 规则", () => {
	const policy = resolvePolicy({ maxRetries: 3, action: "resend" }, { maxRetries: 20 });
	assert.equal(policy.maxRetries, 20);
	assert.equal(policy.action, "resend");
	assert.equal(policy.prompt, "继续");
});

test("参数：合法的收下，不合法的丢掉并记问题，不夹到范围内；不是参数的键留给调用方", () => {
	const problems: string[] = [];
	const patch = readParams(
		{
			action: "loud",
			prompt: "  接着做  ",
			maxRetries: 999,
			maxSameError: 2.5,
			delay: "5s,10s",
			colour: "red",
		},
		problems,
	);
	assert.deepEqual(patch, { prompt: "接着做", delay: { kind: "list", steps: [5_000, 10_000] } });
	assert.deepEqual(problems, [
		"action 只能是 message、resend 或 stop，已忽略",
		"maxRetries 需要 1–50 的整数，已忽略",
		"maxSameError 需要 1–100 的整数，已忽略",
	]);
	assert.deepEqual(readRuleParams({ maxRetries: 0, prompt: " ", delay: 3000 }, "rules[0]（a）.", problems), {});
	assert.deepEqual(problems.slice(3), [
		"rules[0]（a）.prompt 需要 1–500 字的文字，已忽略",
		"rules[0]（a）.maxRetries 需要 1–50 的整数，已忽略",
		"rules[0]（a）.delay 写成 5s,10s,30s 或 3s..15s，已忽略",
	]);
	assert.deepEqual(readParams({ constructor: 1, toString: 2 }, []), {}, "原型上的键不算参数");
	// 规则里读不懂 action 就整条丢掉（读错它可能多发请求）；顶层只忽略这一项。
	const dropped: string[] = [];
	assert.equal(readRuleParams({ action: "loud", maxRetries: 0 }, "rules[1]（b）.", dropped), undefined);
	assert.deepEqual(dropped, ["rules[1]（b）.action 只能是 message、resend 或 stop，已丢弃"]);
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
