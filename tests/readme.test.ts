// README「常见规则」和 example.json 要能直接用：解析无问题，常见错误落到预期的规则上，两边不走样。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { matchFailure, parseConfig } from "../src/policy/config.ts";
import { DEFAULT_POLICY } from "../src/policy/policy.ts";
import { err } from "./support/fake-pi.ts";

const readText = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function commonRules(): Record<string, unknown> {
	const section = readText("README.md").split(/^## .*常见规则\s*$/m)[1];
	assert.ok(section, "README 里要有「常见规则」一节");
	const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(section);
	assert.ok(block, "「常见规则」里要有一段 json");
	return JSON.parse(block[1]!);
}

test("README 常见规则：可直接使用，常见错误各归其位", () => {
	const config = parseConfig(commonRules());
	assert.deepEqual(config.problems, []);
	const cases: [string, string][] = [
		['429 {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', "quota"],
		["该令牌额度已用尽 (request id: 2026102714)", "quota"],
		["You have hit your ChatGPT usage limit (plus plan)", "quota"],
		["prompt is too long: 215000 tokens > 200000 maximum", "context-overflow"],
		["400 This model's maximum context length is 128000 tokens", "context-overflow"],
		["401 Invalid API key (request id: 20261027kwpiDrD)", "auth"],
		['401 {"type":"authentication_error","message":"invalid x-api-key"}', "auth"],
		["429 Too Many Requests", "rate-limit"],
		["Rate limit reached for requests", "rate-limit"],
		["529 overloaded_error", "server"],
		["502 Bad Gateway", "server"],
		["当前分组上游负载已饱和，请稍后再试", "server"],
		["Connection error.", "network"],
		["fetch failed", "network"],
		["Request timed out.", "network"],
		["400 Invalid tool schema", "fallback"],
	];
	const hit = (message: string) => matchFailure(config, err(message));
	for (const [message, rule] of cases) assert.equal(hit(message)?.rule.name, rule, message);

	assert.equal(hit("429 insufficient_quota")?.policy.action, "stop");
	assert.equal(hit("prompt is too long")?.policy.action, "stop");
	assert.equal(hit("401 Invalid API key")?.policy.action, "resend");
	assert.equal(hit("400 Invalid tool schema")?.policy.action, "message");
});

test("example.json：解析无问题，顶层参数就是内置默认值，rules 与 README 一致", () => {
	const example = JSON.parse(readText("example.json"));
	const config = parseConfig(example);
	assert.deepEqual(config.problems, []);
	assert.deepEqual(config.defaults, { ...DEFAULT_POLICY });
	assert.deepEqual(example.rules, commonRules().rules);
});
