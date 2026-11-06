import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFailure, mergeLayers, parseLayer } from "../../src/policy/config.ts";
import { empty, err, rule, stage } from "../support/fake-pi.ts";

test("全局与项目层逐字段合并，rules 整份替换", () => {
	const config = mergeLayers([
		parseLayer({ maxFailures: 5, rules: [rule([stage()], "global")] }),
		parseLayer({ maxFailures: 2, rules: [rule([stage(1, "onward.stop")], "project")] }, true),
	]);
	assert.deepEqual(config.problems, []);
	assert.equal(config.limits.maxFailures, 2);
	assert.equal(config.rules[0]?.name, "project");
});
test("任何层有问题，合并配置不活动", () => {
	const config = mergeLayers([parseLayer({ rules: [rule()] }), parseLayer({ maxFailures: 0 }, true)]);
	assert.equal(config.problems.length, 1);
	assert.equal(matchFailure(config, err(), 1), undefined);
});
test("配置校验错误使用英文并保留字段路径", () => {
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ enabled: "yes" }, /^enabled must be true or false$/],
		[{ quietStartup: "yes" }, /^quietStartup must be true or false$/],
		[{ maxFailures: 0 }, /^maxFailures must be an integer between 1 and 1000$/],
		[{ maxHandoffs: -1 }, /^maxHandoffs must be an integer between 0 and 50$/],
		[{ actionTimeout: "0s" }, /^actionTimeout must be a positive duration/],
		[{ unexpected: true }, /^unexpected is not a recognized field$/],
	];
	for (const [raw, expected] of cases) {
		const { problems } = parseLayer(raw);
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, expected);
		assert.doesNotMatch(problems[0]!, /\p{Script=Han}/u);
	}
	assert.deepEqual(parseLayer({ quietStartup: true }, true).problems, [
		"quietStartup is only allowed in global settings",
	]);
});
test("命中结果按当前失败次数包含规则、阶段、失败和限制", () => {
	const config = mergeLayers([parseLayer({ maxFailures: 4, rules: [rule([stage(), stage(3, "onward.stop")])] })]);
	const hit = matchFailure(config, err(), 3);
	assert.equal(hit?.stage.action.use, "onward.stop");
	assert.equal(hit?.limits.maxFailures, 4);
	assert.equal(hit?.failure.stopReason, "error");
	assert.equal(matchFailure(config, empty(), 1)?.failure.stopReason, "stop");
});
test("没有规则、停用规则或正常消息都不命中", () => {
	assert.equal(matchFailure(mergeLayers([]), err(), 1), undefined);
	const config = mergeLayers([parseLayer({ rules: [{ ...rule(), enabled: false }] })]);
	assert.equal(matchFailure(config, err(), 1), undefined);
});
