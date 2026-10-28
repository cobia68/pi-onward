import assert from "node:assert/strict";
import { test } from "node:test";
import { describePolicy, describeRules } from "../../src/extension/text.ts";
import { parseConfig } from "../../src/policy/config.ts";
import { resolvePolicy } from "../../src/policy/policy.ts";

test("参数说明：方式、间隔表、合计、同错上限", () => {
	assert.equal(
		describePolicy(resolvePolicy({})),
		"发「继续」，最多 10 次；间隔 3 秒 → 6 秒 → 9 秒 → 12 秒 → 15 秒 → 15 秒 …（合计约 2 分）；同一个错误连续 10 次后也停",
	);
	assert.match(
		describePolicy(resolvePolicy({ action: "resend", maxRetries: 2 })),
		/^静默重发同一请求，最多 2 次；间隔 3 秒 → 6 秒（/,
	);
	assert.equal(describePolicy(resolvePolicy({ action: "stop" })), "命中就停，只提醒，不续跑");
});

test("rules 列表；有问题时只列问题", () => {
	assert.match(describeRules(parseConfig(undefined)), /^没有可用的规则，出错时不会自动续跑/);
	assert.match(
		describeRules(
			parseConfig({ rules: [{ name: "auth", when: { error: "401", provider: "welfare-*" }, action: "resend" }] }),
		),
		/^按顺序第一条命中的生效，没有命中的错误不处理：\n1\. auth：错误匹配 \/401\/i，provider=welfare-\* → 静默重发同一请求/,
	);
	assert.equal(
		describeRules(parseConfig({ rules: [{ name: "auth", when: { error: "401" } }, { when: { x: 1 } }] })),
		"设置文件有 1 处问题，修好之前不会自动续跑：\n- rules[1]（rule-2）.when.x 不认识\n改完 /onward reload",
	);
});
