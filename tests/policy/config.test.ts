import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFailure, migrateLegacy, parseConfig } from "../../src/policy/config.ts";
import { aborted, err, ok } from "../support/fake-pi.ts";

test("没有设置文件：开、无规则", () => {
	const empty = { enabled: true, defaults: {}, rules: [], problems: [] };
	assert.deepEqual(parseConfig(undefined), empty);
	assert.deepEqual(parseConfig(null), empty);
});

test("顶层：enabled、未知键、不是对象", () => {
	assert.equal(parseConfig({ enabled: false }).enabled, false);
	assert.deepEqual(parseConfig({ enabled: "no", foo: 1 }).problems, [
		"enabled 需要 true 或 false",
		"foo 不认识，已忽略",
	]);
	assert.deepEqual(parseConfig("nope").problems, ["设置文件不是对象，已忽略"]);
});

test("命中：开着、是失败、有规则命中；参数是 defaults 叠上规则", () => {
	const config = parseConfig({
		defaults: { maxRetries: 3, mode: "silent" },
		rules: [{ name: "auth", when: { match: "401" }, budget: { maxRetries: 20 } }],
	});
	const hit = matchFailure(config, err());
	assert.equal(hit?.rule.name, "auth");
	assert.equal(hit?.policy.maxRetries, 20);
	assert.equal(hit?.policy.mode, "silent");
	assert.equal(matchFailure(config, err("502 upstream")), undefined, "没命中");
	assert.equal(matchFailure(config, ok()), undefined);
	assert.equal(matchFailure(config, aborted()), undefined);
	assert.equal(matchFailure({ ...config, enabled: false }, err()), undefined);
});

test("旧版 auto-continue.json 迁成 enabled + defaults，不生成规则", () => {
	assert.deepEqual(
		migrateLegacy({ enabled: false, maxRetries: 50, mode: "silent", prompt: "接着干", retryDelaysMs: [] }),
		{
			enabled: false,
			defaults: { maxRetries: 50, mode: "silent", prompt: "接着干", retryDelaysMs: [] },
			rules: [],
			problems: [],
		},
	);
});
