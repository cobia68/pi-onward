import assert from "node:assert/strict";
import { test } from "node:test";
import { fileOrder, isActive, matchFailure, mergeLayers, parseLayer } from "../../src/policy/config.ts";
import { parseConfig } from "../support/config.ts";
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

test("写回时的键顺序：$schema、enabled、参数、quietStartup、其他、rules", () => {
	assert.deepEqual(
		Object.keys(
			fileOrder({
				rules: [],
				note: 1,
				quietStartup: true,
				delay: "1s",
				enabled: true,
				action: "stop",
				$schema: "s",
			}),
		),
		["$schema", "enabled", "action", "delay", "quietStartup", "note", "rules"],
	);
});

test("quietStartup：只认 true、false；项目级的一份不能写，写了算一处问题，也不进合并", () => {
	assert.deepEqual(parseLayer({ quietStartup: true }), { quietStartup: true, defaults: {}, problems: [] });
	assert.deepEqual(parseLayer({ quietStartup: "header" }).problems, ["quietStartup 需要 true 或 false"]);
	const project = parseLayer({ quietStartup: false, maxRetries: 2 }, true);
	assert.deepEqual(project, { defaults: { maxRetries: 2 }, problems: ["quietStartup 只能写在全局设置"] });
	assert.equal(mergeLayers([parseLayer({ quietStartup: true }), project]).quietStartup, true);
	assert.equal("quietStartup" in mergeLayers([parseLayer({})]), false, "都没写：跟着 pi 的");
});

test("一份文件读成一层：只有写了的字段；rules 写了才有，空数组也算写了", () => {
	assert.deepEqual(parseLayer({}), { defaults: {}, problems: [] });
	assert.deepEqual(parseLayer({ enabled: false, maxRetries: 3, rules: [] }), {
		enabled: false,
		defaults: { maxRetries: 3 },
		rules: [],
		problems: [],
	});
	assert.equal(parseLayer({ enabled: "no" }).enabled, undefined, "读不懂的开关不算写了");
	assert.deepEqual(parseLayer({ rules: null }).problems, ["rules 需要数组"]);
});

test("几层合并：后面的覆盖前面的，顶层字段逐个覆盖，rules 整份替换", () => {
	const user = parseLayer({ enabled: false, maxRetries: 5, delay: "5s", rules: [{ name: "any" }] });
	const project = parseLayer({ enabled: true, maxRetries: 2, rules: [{ name: "auth", when: { error: "401" } }] });
	const merged = mergeLayers([user, project]);
	assert.equal(merged.enabled, true);
	assert.deepEqual(Object.keys(merged.defaults), ["maxRetries", "delay"]);
	assert.equal(merged.defaults.maxRetries, 2);
	assert.deepEqual(
		merged.rules.map((rule) => rule.name),
		["auth"],
		"不拼接",
	);
	assert.deepEqual(
		mergeLayers([user, parseLayer({ maxRetries: 2 })]).rules.map((rule) => rule.name),
		["any"],
		"后面没写 rules：用前面的",
	);
	assert.deepEqual(mergeLayers([user, parseLayer({ rules: [] })]).rules, [], "后面写了空的 rules：没有规则");
	assert.equal(mergeLayers([user, parseLayer({})]).enabled, false, "后面没写开关：用前面的");
});

test("几层合并：任何一层有问题，整份不生效", () => {
	const good = parseLayer({ rules: [{ name: "any" }] });
	const bad = parseLayer({ maxRetries: 99 });
	for (const layers of [
		[good, bad],
		[bad, good],
	]) {
		const merged = mergeLayers(layers);
		assert.deepEqual(merged.problems, ["maxRetries 需要 1–50 的整数"]);
		assert.equal(isActive(merged), false);
		assert.equal(matchFailure(merged, err()), undefined);
	}
});
