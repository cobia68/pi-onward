// 规则诊断：空兜底是配置错误；遮挡和不适用的显式参数只提醒，不改变执行结果。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRules } from "../../src/extension/text.ts";
import { isActive, matchFailure } from "../../src/policy/config.ts";
import { parseConfig } from "../support/config.ts";
import { empty, err, harness, writeConfig } from "../support/fake-pi.ts";

const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });
const REMINDERS = "规则提醒（不影响设置生效）";

test("兜底必须显式写 action：空对象、只有名字、空 when 都不能继承顶层动作", () => {
	for (const rule of [{}, { name: "fallback" }, { name: "fallback", when: {} }, { enabled: false }]) {
		const config = parseConfig({
			action: "resend",
			rules: [rule, { name: "quota", when: { failure: "quota" }, action: "stop" }],
		});
		assert.equal(config.problems.length, 1, JSON.stringify(rule));
		assert.match(config.problems[0]!, /action 不能省略：兜底规则需要明确写 message、resend 或 stop$/);
		assert.equal(isActive(config), false);
		assert.equal(matchFailure(config, err("quota exceeded")), undefined, "不会带着坏规则继续执行");
	}
});

test("显式兜底和带条件的规则仍合法：有条件时可以继承动作", () => {
	for (const when of [undefined, {}]) {
		for (const action of ["message", "resend", "stop"]) {
			const config = parseConfig({ rules: [{ ...(when && { when }), action }] });
			assert.deepEqual(config.problems, []);
			assert.equal(matchFailure(config, err())?.policy.action, action);
			assert.equal(matchFailure(config, empty())?.policy.action, action);
		}
	}
	const config = parseConfig({ action: "resend", rules: [{ when: { failure: "401" } }] });
	assert.deepEqual(config.problems, []);
	assert.equal(matchFailure(config, err())?.policy.action, "resend");
});

test("兜底遮挡所有后续失败规则，包括空回复；只提醒、不改变顺序", async () => {
	const h = harness({
		config: {
			delay: "0s",
			rules: [
				{ name: "fallback", action: "message" },
				{ name: "quota", when: { failure: "quota" }, action: "stop" },
				{ name: "empty", when: { failure: "^$" } },
			],
		},
	});
	await start(h);
	assert.deepEqual(h.warnings(), ["onward：规则有 2 处提醒，不影响设置生效（/onward show 查看）"]);
	const text = await h.command("show rules");
	assert.ok(text.includes(REMINDERS));
	assert.match(text, /rules\[1\]（quota）被前面的兜底规则「fallback」挡住，不会命中/);
	assert.match(text, /rules\[2\]（empty）被前面的兜底规则「fallback」挡住，不会命中/);
	assert.equal(h.notes.at(-1)![0], "warning");
	await h.boundary(err("quota exceeded"));
	assert.deepEqual(h.sent, ["继续"], "提醒不会擅自改变规则顺序");
	await h.boundary(empty());
	assert.deepEqual(h.sent, ["继续", "继续"]);
	assert.equal(h.status(), "⏩ 续跑 2/10 · fallback");
});

test("停用的兜底不遮挡，停用的规则不提醒；不猜测正则或通配条件的覆盖关系", () => {
	const config = parseConfig({
		rules: [
			{ name: "off", enabled: false, action: "stop", delay: "5s" },
			{ name: "auth", when: { failure: "401" } },
			{ name: "relay", when: { provider: "relay-*" } },
			{ name: "fallback", action: "message" },
			{ name: "disabled", enabled: false, when: { failure: "quota" }, action: "resend", prompt: "不用" },
		],
	});
	assert.deepEqual(config.problems, []);
	assert.ok(!describeRules(config).includes(REMINDERS));
	assert.equal(matchFailure(config, err())?.rule.name, "auth");
});

test("resend 显式写 prompt 时提醒，仍然静默重发，不把 prompt 发给模型", async () => {
	const h = harness({
		config: { delay: "0s", rules: [{ name: "auth", when: { failure: "401" }, action: "resend", prompt: "接着做" }] },
	});
	const text = await h.command("show");
	assert.ok(text.includes(REMINDERS));
	assert.match(text, /rules\[0\]（auth）的 prompt 在 action=resend 时不使用/);
	const result = await h.boundary(err(), "auth-error");
	assert.deepEqual(result.entries, [{ type: "context_edit", targetId: "auth-error", replacement: null }]);
	assert.deepEqual(h.sent, []);
});

test("stop 显式写续跑参数时合成一条提醒，不等待、不续跑", async () => {
	const h = harness({
		config: {
			rules: [{ name: "quota", action: "stop", prompt: "继续", maxRetries: 5, maxSameError: 2, delay: "1m" }],
		},
	});
	const text = await h.command("show rules");
	assert.match(text, /rules\[0\]（quota）的 prompt、maxRetries、maxSameError、delay 在 action=stop 时不使用/);
	assert.equal(await h.boundary(err()), undefined);
	assert.deepEqual(h.sent, []);
});

test("继承来的默认参数不提醒，message 使用显式参数也不提醒", () => {
	for (const action of ["resend", "stop"]) {
		const config = parseConfig({ prompt: "默认消息", maxRetries: 5, delay: "1s", rules: [{ action }] });
		assert.deepEqual(config.problems, []);
		assert.ok(!describeRules(config).includes(REMINDERS), action);
	}
	const message = parseConfig({ rules: [{ action: "message", prompt: "继续", maxRetries: 3, delay: "1s" }] });
	assert.ok(!describeRules(message).includes(REMINDERS));
});

test("按合并后的动作诊断：项目级和命令改变动作后，提醒随之更新", async () => {
	const h = harness({
		config: { rules: [{ name: "auth", when: { failure: "401" }, prompt: "接着做" }] },
		project: { action: "resend" },
	});
	await start(h);
	assert.deepEqual(h.warnings(), ["onward：用上了项目级设置；规则有 1 处提醒，不影响设置生效（/onward show 查看）"]);
	assert.match(await h.command("status"), /规则有 1 处提醒，不影响设置生效/);
	assert.match(await h.command("show rules"), /prompt 在 action=resend 时不使用/);
	assert.doesNotMatch(await h.command("--scope project set action=message"), /规则有 \d+ 处提醒/);
	assert.ok(!(await h.command("show rules")).includes(REMINDERS));
	await h.command("--scope project unset action");
	assert.match(await h.command("set action=resend"), /规则有 1 处提醒/);
	assert.equal(h.notes.at(-1)![0], "warning");
});

test("只诊断实际采用的规则：项目级替换全局 rules 后不显示被替换规则的提醒", async () => {
	const h = harness({
		config: { rules: [{ action: "resend", prompt: "不用" }] },
		project: { rules: [{ when: { failure: "401" } }] },
	});
	await start(h);
	assert.deepEqual(h.warnings(), []);
	assert.ok(!(await h.command("show rules")).includes(REMINDERS));
});

test("规则提醒不受 quietStartup 影响；没有界面时不提示但执行照常", async () => {
	const config = { delay: "0s", rules: [{ action: "resend", prompt: "不用" }] };
	for (const quietStartup of [true, "header"]) {
		const h = harness({ config, piSettings: { quietStartup } });
		await start(h);
		assert.equal(h.warnings().length, 1, String(quietStartup));
	}
	const own = harness({ config: { ...config, quietStartup: true } });
	await start(own);
	assert.equal(own.warnings().length, 1);
	const headless = harness({ config, ui: false });
	await start(headless);
	assert.equal((await headless.boundary(err()))?.continue, true);
	assert.deepEqual(headless.notes, []);
});

test("reload 后重新诊断；有配置错误时只报错误，不列仍生效的规则或提醒", async () => {
	const h = harness({ config: { rules: [{ action: "message" }] } });
	writeConfig({ rules: [{ action: "resend", prompt: "不用" }] }, h.configPath);
	assert.match(await h.command("reload"), /规则有 1 处提醒/);
	writeConfig({ rules: [{}] }, h.configPath);
	assert.match(await h.command("reload"), /修好之前不会自动续跑/);
	const text = await h.command("show rules");
	assert.match(text, /action 不能省略/);
	assert.ok(!text.includes(REMINDERS));
	assert.equal(await h.boundary(err()), undefined);
});
