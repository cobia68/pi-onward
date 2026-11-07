import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseLayer } from "../../src/policy/config.ts";
import { configSchema } from "../../src/policy/schema.ts";
import { rule, stage } from "../support/fake-pi.ts";

const schema = configSchema();
const validate = new Ajv2020({ strict: false }).compile(schema);

test("提交的 Schema 与生成器完全一致", () => {
	assert.deepEqual(JSON.parse(readFileSync(new URL("../../onward.schema.json", import.meta.url), "utf8")), schema);
});
test("Schema 接受新结构，拒绝旧平铺策略与非法动作结构", () => {
	const good = { rules: [rule([stage(), stage(3, "respawn.restart", { model: "other" })])] };
	assert.equal(validate(good), true, JSON.stringify(validate.errors));
	assert.deepEqual(parseLayer(good).problems, []);
	for (const raw of [
		{ action: "resend" },
		{ maxRetries: 3 },
		{ rules: [{ action: "message" }] },
		{ rules: [rule([stage(2)])] },
		{ rules: [rule([stage(1, "bad")])] },
	])
		assert.equal(validate(raw), false, JSON.stringify(raw));
});
test("Schema 和读取器使用 minFailures，拒绝旧字段及新旧字段混用", () => {
	const current = { rules: [{ stages: [{ minFailures: 1, action: { use: "pi.message" } }] }] };
	assert.equal(validate(current), true, JSON.stringify(validate.errors));
	assert.deepEqual(parseLayer(current).problems, []);
	for (const threshold of [{ fromFailure: 1 }, { minFailures: 1, fromFailure: 1 }]) {
		const legacy = { rules: [{ stages: [{ ...threshold, action: { use: "pi.message" } }] }] };
		assert.equal(validate(legacy), false);
		assert.ok(parseLayer(legacy).problems.includes("rules[0].stages[0].fromFailure is not a recognized field"));
	}
});
test("动作参数由注册表校验，编辑器 Schema 不把插件名称写死", () => {
	assert.equal(validate({ rules: [rule([stage(1, "future.plugin", { value: [1, 2] })])] }), true);
});
