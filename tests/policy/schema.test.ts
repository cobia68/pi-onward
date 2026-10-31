// onward.schema.json：从字段表生成，提交的文件不能过期；它允许的写法要和读设置时收下的一致。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIG_KEYS, parseLayer } from "../../src/policy/config.ts";
import { DELAY_PATTERN, parseDelay } from "../../src/policy/delay.ts";
import { DEFAULT_POLICY, FIELDS } from "../../src/policy/policy.ts";
import { RULE_KEYS } from "../../src/policy/rules.ts";
import { configSchema, SCHEMA_URL } from "../../src/policy/schema.ts";

type Schema = Record<string, any>;

const readJson = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
const schema: Schema = configSchema();

test("提交的 onward.schema.json 就是字段表生成的；过期了运行 npm run gen:schema", () => {
	assert.deepEqual(readJson("onward.schema.json"), schema);
});

test("键和读设置时认的一样：顶层、规则、条件都不多不少", () => {
	assert.deepEqual(Object.keys(schema.properties).sort(), [...CONFIG_KEYS].sort());
	assert.deepEqual(Object.keys(schema.$defs.rule.properties).sort(), [...RULE_KEYS].sort());
	for (const key of Object.keys(schema.$defs.when.properties)) {
		const problems = parseLayer({ rules: [{ when: { [key]: key === "empty" ? true : "x" } }] }).problems;
		assert.deepEqual(problems, [], key);
	}
	assert.deepEqual(parseLayer({ rules: [{ when: { colour: "red" } }] }).problems, [
		"rules[0]（rule-1）.when.colour 不认识",
	]);
	for (const part of [schema, schema.$defs.rule, schema.$defs.when]) assert.equal(part.additionalProperties, false);
	// empty 和 error 不能一起写：读设置时记成问题，schema 也不允许。
	assert.deepEqual(schema.$defs.when.dependentSchemas, { empty: { properties: { error: false } } });
	assert.match(
		parseLayer({ rules: [{ when: { empty: true, error: "x" } }] }).problems.join(),
		/empty 和 error 不能一起写/,
	);
});

test("每个参数的取值和读设置时一样：范围、可选值、写法", () => {
	for (const item of FIELDS) {
		const top = schema.properties[item.name];
		assert.deepEqual(schema.$defs.rule.properties[item.name].enum, top.enum, item.name);
		if (top.type === "integer") {
			for (const value of [top.minimum, top.maximum])
				assert.ok("value" in item.read(value), `${item.name}=${value}`);
			for (const value of [top.minimum - 1, top.maximum + 1, 1.5])
				assert.ok("problem" in item.read(value), `${item.name}=${value}`);
		}
		if (top.enum) {
			assert.deepEqual(
				top.enum,
				item.choices?.map((choice) => choice.value),
			);
			assert.ok("problem" in item.read("loud"));
		}
	}
	assert.ok("value" in FIELDS.find((item) => item.name === "prompt")!.read("x".repeat(500)));
	assert.ok("problem" in FIELDS.find((item) => item.name === "prompt")!.read("x".repeat(501)));
});

test("delay 的写法：编辑器认的和 parseDelay 收的一样；超出范围这类意思上的问题只有读设置时才查", () => {
	const pattern = new RegExp(DELAY_PATTERN);
	for (const text of ["3s", "500ms", "1.5s", "2m", "3s..15s", " 5s , 10s,30s ", "1ms"]) {
		assert.ok(pattern.test(text), text);
		assert.equal(typeof parseDelay(text), "object", text);
	}
	for (const text of [
		"",
		"5",
		"5s,",
		",5s",
		"5s;10s",
		"3s..",
		"3s..15",
		"3s .. 15s",
		"3s..15s..20s",
		"5 s",
		"1h",
		"5S",
		"1MS",
		"2M",
	]) {
		assert.ok(!pattern.test(text), text);
		assert.equal(typeof parseDelay(text), "string", text);
	}
	for (const text of ["15s..3s", "61m"]) {
		assert.ok(pattern.test(text), text);
		assert.equal(typeof parseDelay(text), "string", text);
	}
});

test("顶层的默认值就是内置默认值，规则里的不写默认值：规则没写的用顶层的", () => {
	const example = readJson("example.json");
	for (const item of FIELDS) {
		assert.deepEqual(schema.properties[item.name].default, example[item.name], item.name);
		assert.equal("default" in schema.$defs.rule.properties[item.name], false, item.name);
	}
	assert.equal(schema.properties.prompt.default, DEFAULT_POLICY.prompt);
});

test("地址只有一个：schema 的 $id、example.json 的 $schema、README 里写的", () => {
	assert.equal(schema.$id, SCHEMA_URL);
	assert.equal(readJson("example.json").$schema, SCHEMA_URL);
	const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
	assert.ok(readme.includes(`"$schema": "${SCHEMA_URL}"`));
	assert.ok(readJson("package.json").files.includes("onward.schema.json"), "随 npm 包发布");
});
