import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, fieldNamed, readLimits, resolveLimits } from "../../src/policy/policy.ts";

test("恢复上限与动作参数分离，默认值只有流程限制", () => {
	assert.deepEqual(resolveLimits({}), { maxFailures: 20, maxHandoffs: 3, actionTimeout: 30_000 });
	assert.deepEqual(resolveLimits({ maxFailures: 3 }), { ...DEFAULT_LIMITS, maxFailures: 3 });
	assert.equal(fieldNamed("maxRetries"), undefined);
});
test("限制严格校验，不转换 JSON 字符串或夹到合法范围", () => {
	const problems: string[] = [];
	assert.deepEqual(readLimits({ maxFailures: 3, maxHandoffs: 0, actionTimeout: "2s" }, problems), {
		maxFailures: 3,
		maxHandoffs: 0,
		actionTimeout: 2000,
	});
	assert.deepEqual(problems, []);
	for (const raw of [
		{ maxFailures: "3" },
		{ maxFailures: 0 },
		{ maxFailures: 1001 },
		{ maxHandoffs: -1 },
		{ actionTimeout: "0s" },
		{ actionTimeout: "61m" },
	]) {
		const errors: string[] = [];
		assert.deepEqual(readLimits(raw, errors), {});
		assert.equal(errors.length, 1);
	}
});
