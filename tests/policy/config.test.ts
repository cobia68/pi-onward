import assert from "node:assert/strict";
import { test } from "node:test";
import { fileOrder, isActive, matchFailure, parseConfig } from "../../src/policy/config.ts";
import { aborted, err, ok } from "../support/fake-pi.ts";

test("没有设置文件：开、无规则", () => {
	assert.deepEqual(parseConfig(undefined), { enabled: true, defaults: {}, rules: [], problems: [] });
});

test("顶层：enabled、参数、未知键", () => {
	assert.equal(parseConfig({ enabled: false }).enabled, false);
	assert.deepEqual(parseConfig({ maxRetries: 3, prompt: "接着做" }).defaults, { maxRetries: 3, prompt: "接着做" });
	assert.deepEqual(parseConfig({ enabled: "no", foo: 1, maxRetries: 99 }).problems, [
		"enabled 需要 true 或 false",
		"maxRetries 需要 1–50 的整数",
		"foo 不认识",
	]);
	assert.equal(parseConfig({ $schema: "x", rules: [] }).problems.length, 0);
});

test("有问题就整份不生效：不会落到更宽的规则或默认值上", () => {
	// 拼错的 action 让 quota 不生效。只丢掉它的话，额度错误会落到后面的兜底去续跑。
	const typo = parseConfig({
		rules: [{ name: "quota", when: { error: "quota" }, acton: "stop" }, { name: "any" }],
	});
	assert.equal(isActive(typo), false);
	assert.equal(matchFailure(typo, err("429 insufficient_quota")), undefined);
	assert.equal(matchFailure(typo, err("502 upstream")), undefined);
	// 顶层的参数写坏了也一样：不退回内置的 10 次。
	assert.equal(matchFailure(parseConfig({ maxRetries: 99, rules: [{ name: "any" }] }), err()), undefined);
	// enabled 写成字符串不算开。
	assert.equal(matchFailure(parseConfig({ enabled: "false", rules: [{ name: "any" }] }), err()), undefined);
});

test("命中：开着、是失败、有规则命中；参数是顶层叠上规则", () => {
	const config = parseConfig({
		maxRetries: 3,
		action: "resend",
		rules: [{ name: "auth", when: { error: "401" }, maxRetries: 20 }],
	});
	const hit = matchFailure(config, err());
	assert.equal(hit?.rule.name, "auth");
	assert.equal(hit?.policy.maxRetries, 20);
	assert.equal(hit?.policy.action, "resend");
	assert.equal(matchFailure(config, err("502 upstream")), undefined, "没命中");
	assert.equal(matchFailure(config, ok()), undefined);
	assert.equal(matchFailure(config, aborted()), undefined);
	assert.equal(matchFailure({ ...config, enabled: false }, err()), undefined);
});

test("写回时的键顺序：$schema、enabled、参数、其他、rules", () => {
	assert.deepEqual(
		Object.keys(fileOrder({ rules: [], note: 1, delay: "1s", enabled: true, action: "stop", $schema: "s" })),
		["$schema", "enabled", "action", "delay", "note", "rules"],
	);
});
