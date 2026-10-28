import assert from "node:assert/strict";
import { test } from "node:test";
import { renderContinue } from "../../src/extension/render.ts";
import { continueLabel, describeDelay, describeRules } from "../../src/extension/text.ts";
import { parseConfig } from "../../src/policy/config.ts";
import { parseDelay } from "../../src/policy/delay.ts";
import { type Policy, resolvePolicy } from "../../src/policy/policy.ts";

const delay = (text: string, maxRetries: number) =>
	describeDelay(resolvePolicy({ delay: parseDelay(text) as Policy["delay"], maxRetries }));

test("间隔：列到不再变为止，后面说之后每次；单位相同只写一次", () => {
	assert.equal(describeDelay(resolvePolicy({})), "3 → 6 → 9 → 12 → 15 秒，之后每次 15 秒；10 次合计约 2 分");
	assert.equal(
		describeDelay(resolvePolicy({ maxRetries: 50 })),
		"3 → 6 → 9 → 12 → 15 秒，之后每次 15 秒；50 次合计约 12 分",
	);
	assert.equal(delay("3s..15s", 2), "3 → 6 秒；2 次合计约 9 秒", "没到封顶就用完了");
	assert.equal(delay("3s..15s", 1), "3 秒");
	assert.equal(delay("5s", 4), "每次 5 秒；4 次合计约 20 秒");
	assert.equal(delay("40ms", 10), "每次 40 毫秒；10 次合计约 400 毫秒");
	// 单位不同时各写各的。
	assert.equal(delay("30s,1m,2m", 5), "30 秒 → 1 分 → 2 分，之后每次 2 分；5 次合计约 7 分 30 秒");
	// 太长的中间省掉。
	assert.equal(delay("1s..30s", 50), "1 → 2 → 3 → 4 → 5 → … → 30 秒，之后每次 30 秒；50 次合计约 17 分 45 秒");
});

test("规则：每条一块，条件、做法、上限、间隔各一行；stop 只有做法", () => {
	const text = describeRules(
		parseConfig({
			rules: [
				{ name: "auth", when: { error: "401", provider: "welfare-*" }, action: "resend", maxRetries: 20 },
				{ name: "quota", when: { error: "quota" }, action: "stop", enabled: false },
			],
		}),
	);
	assert.equal(
		text,
		[
			"规则（按顺序，第一条命中的生效；没命中的错误不处理）",
			"1. auth",
			"   条件  错误匹配 /401/i，provider=welfare-*",
			"   做法  静默重发同一个请求",
			"   上限  最多 20 次；同一个错误连续 10 次后也停",
			"   间隔  3 → 6 → 9 → 12 → 15 秒，之后每次 15 秒；20 次合计约 4 分 30 秒",
			"2. quota（已停用）",
			"   条件  错误匹配 /quota/i",
			"   做法  命中就停，只提醒，不续跑",
		].join("\n"),
	);
});

test("规则：没有时说怎么加；有问题时只列问题", () => {
	assert.match(
		describeRules(parseConfig(undefined)),
		/^没有可用的规则，出错时不会自动续跑。在设置文件的 rules 里写规则/,
	);
	assert.equal(
		describeRules(parseConfig({ rules: [{ name: "auth", when: { error: "401" } }, { when: { x: 1 } }] })),
		"设置文件有 1 处问题，修好之前不会自动续跑：\n- rules[1]（rule-2）.when.x 不认识\n改完 /onward reload",
	);
});

test("续跑消息：标签写第几次和哪条规则，记录不全时退回只写名字", () => {
	assert.equal(continueLabel({ rule: "auth", attempt: 2, max: 20 }), "⏩ onward · 续跑 2/20 · auth");
	assert.equal(continueLabel({ rule: "auth" }), "⏩ onward · auth");
	assert.equal(continueLabel(undefined), "⏩ onward");
	assert.equal(continueLabel({ rule: 3 }), "⏩ onward");
});

test("续跑消息：渲染成标签加原文，原文不变", () => {
	const plain = {
		fg: (_: string, text: string) => text,
		bg: (_: string, text: string) => text,
		bold: (t: string) => t,
	};
	const message = {
		role: "custom",
		customType: "pi-onward",
		content: "上一步出错了，接着做",
		display: true,
		details: { rule: "fallback", attempt: 1, max: 3 },
		timestamp: 0,
	} as const;
	const box = renderContinue(message, { expanded: false, outputPad: 1 }, plain as never)!;
	const lines = box.render(60).map((line) => line.trimEnd());
	assert.deepEqual(
		lines.filter((line) => line.trim()),
		[" ⏩ onward · 续跑 1/3 · fallback", " 上一步出错了，接着做"],
	);
});
