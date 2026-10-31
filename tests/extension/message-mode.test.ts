import assert from "node:assert/strict";
import { test } from "node:test";
import { aborted, boundaryEvent, empty, err, harness, ok, tool } from "../support/fake-pi.ts";

/** 兜底规则：没有内置规则，测试里要自己写。 */
const any = [{ name: "any" }];
const fast = (params: Record<string, unknown> = {}) => ({
	config: { delay: "0s", ...params, rules: any },
});

test("在收尾边界上追加一条看得见的消息并要求继续", async () => {
	const h = harness(fast());
	const prior = { type: "custom", customType: "x" };
	const result = await h.emit("agent_before_settle", boundaryEvent(err(), "e1", { entries: [prior] }));
	assert.deepEqual(result, {
		entries: [
			prior,
			{
				type: "custom_message",
				customType: "pi-onward",
				content: "继续",
				display: true,
				details: { rule: "any", attempt: 1, max: 10 },
			},
		],
		continue: true,
	});
	assert.match(h.notes.at(-1)![1], /^onward：0 毫秒后发「继续」$/);
});

test("默认 10 次；同一个错误连续第 11 次才彻底停，只提醒一次", async () => {
	const h = harness(fast());
	for (let i = 0; i < 10; i++) await h.boundary(err());
	assert.equal(h.sent.length, 10);
	assert.deepEqual(h.warnings(), []);
	assert.equal(await h.boundary(err()), undefined);
	assert.match(h.warnings()[0], /同一个错误已连续 11 次/);
	await h.boundary(err());
	assert.equal(h.warnings().length, 1);
});

test("错误在变：只撞次数上限", async () => {
	const h = harness(fast());
	for (let i = 0; i < 10; i++) await h.boundary(err(i % 2 ? "401 Invalid API key" : "429 rate limited"));
	await h.boundary(err("502 upstream"));
	assert.equal(h.sent.length, 10);
	assert.match(h.warnings()[0], /已续跑 10 次仍未恢复/);
});

test("只处理以错误收尾的：正常结束、Esc 不续跑", async () => {
	const h = harness(fast());
	assert.equal(await h.boundary(ok()), undefined);
	assert.equal(await h.boundary(aborted()), undefined);
	assert.deepEqual(h.sent, []);
});

test("续跑成功后再出错：次数从头算", async () => {
	const h = harness(fast({ maxRetries: 2 }));
	await h.boundary(err());
	await h.boundary(err());
	// 第 2 次续跑之后模型正常干了一阵（工具轮），然后又撞上 401。
	await h.emit("message_end", { message: tool() });
	await h.boundary(err());
	assert.equal(h.sent.length, 3);
	assert.deepEqual(h.warnings(), []);
	assert.equal(h.status(), "⏩ 续跑 1/2 · any", "次数从头算");
});

test("用户自己开新一轮：额度清零", async () => {
	const h = harness(fast({ maxSameError: 3 }));
	for (let i = 0; i < 4; i++) await h.boundary(err());
	assert.equal(h.sent.length, 3);
	await h.emit("agent_start");
	await h.boundary(err());
	assert.equal(h.sent.length, 4);
});

test("间隔真的等够，提示词模板生效", async () => {
	const h = harness(fast({ delay: "40ms", prompt: "第 {attempt}/{max} 次：{error}" }));
	const started = Date.now();
	await h.boundary(err());
	assert.ok(Date.now() - started >= 30);
	assert.deepEqual(h.sent, ["第 1/10 次：401 invalid api key"]);
	assert.match(h.notes.at(-1)![1], /^onward：40 毫秒后发「第 1\/10 次：401 invalid api key」$/);
});

test("等的时候：按 Esc、用户发了消息、关掉，都不续跑", async () => {
	const esc = harness(fast({ delay: "200ms" }));
	const waiting = esc.boundary(err());
	setTimeout(() => esc.controller.abort(), 20);
	assert.equal(await waiting, undefined);

	const typed = harness(fast({ delay: "60ms" }));
	const pending = typed.boundary(err());
	setTimeout(() => (typed.pending = 1), 20);
	assert.equal(await pending, undefined);
	assert.deepEqual(typed.sent, []);
	typed.pending = 1;
	assert.equal(await typed.boundary(err()), undefined, "已经有排队的消息：不插手");

	const off = harness(fast({ delay: "5s" }));
	const started = Date.now();
	const stopped = off.boundary(err());
	setTimeout(() => off.command("off"), 20);
	assert.equal(await stopped, undefined);
	assert.ok(Date.now() - started < 1_000, "关掉时立刻打断等待");
	assert.equal(await off.boundary(err()), undefined);
});

test("同一会话装了两份：只有一份干活，上限照常", async () => {
	const h = harness({ ...fast({ maxRetries: 2 }), copies: 2 });
	for (let i = 0; i < 4; i++) await h.boundary(err(`500 x${i}`));
	assert.equal(h.sent.length, 2);
	assert.equal(h.warnings().length, 1);
});

test("规则：没命中的错误不处理；各规则的提示词与次数", async () => {
	const h = harness({
		config: {
			delay: "0s",
			rules: [
				{ name: "auth", when: { error: "401" }, prompt: "鉴权抖了，接着干", maxRetries: 1 },
				{ name: "busy", when: { error: "429|502" } },
			],
		},
	});
	await h.boundary(err("Connection error."));
	assert.deepEqual(h.sent, [], "没命中");
	await h.boundary(err("401 Invalid API key"));
	await h.boundary(err("429 rate limited"));
	await h.boundary(err("401 Invalid API key"));
	assert.deepEqual(h.sent, ["鉴权抖了，接着干", "继续"]);
	assert.match(h.warnings()[0], /^onward：已续跑 1 次仍未恢复；发任意消息重新计数$/);
	assert.match(h.notes.find(([, m]) => m.includes("鉴权"))![1], /^onward：0 毫秒后发「鉴权抖了，接着干」$/);
});

test("规则按 provider 匹配", async () => {
	const h = harness({ config: { delay: "0s", rules: [{ when: { provider: "welfare-*" } }] } });
	await h.boundary(err("401", { provider: "openai" }));
	await h.boundary(err("401", { provider: "welfare-k40" }));
	assert.equal(h.sent.length, 1);
});

test("没有内置规则：没写 rules 或全部写坏都不续跑，启动时提醒", async () => {
	const none = harness({ config: { delay: "0s" } });
	await none.emit("session_start", { reason: "startup" });
	assert.match(none.notes.at(-1)![1], /^💤 onward：没有可用的规则，出错时不会自动续跑/);
	assert.equal(none.notes.at(-1)![0], "info");
	assert.equal(await none.boundary(err()), undefined);
	assert.match(await none.command("status"), /^💤 onward：开，但没有可用的规则/);

	// 只想处理 401，但 when 的键拼错了：整份设置不生效，也不会退回「任何错误都续跑」。
	const typo = harness({
		config: { delay: "0s", rules: [{ name: "auth", when: { errr: "401" } }] },
	});
	await typo.emit("session_start", { reason: "startup" });
	assert.match(typo.warnings()[0], /onward\.json 有 1 处问题，修好之前不会自动续跑/);
	assert.equal(await typo.boundary(err("429 rate limited")), undefined);

	// 全部停用也算没有可用的规则；关掉了就不提醒。
	const off = harness({ config: { rules: [{ name: "a", enabled: false }] } });
	await off.emit("session_start", { reason: "startup" });
	assert.match(off.notes.at(-1)![1], /没有可用的规则/);
	const disabled = harness({ config: { enabled: false } });
	await disabled.emit("session_start", { reason: "startup" });
	assert.deepEqual(disabled.notes, []);
});

test("action=stop 的规则：命中就停、只提醒，不会落到后面的兜底", async () => {
	const h = harness({
		config: {
			delay: "0s",
			rules: [{ name: "quota", when: { error: "quota" }, action: "stop" }, { name: "any" }],
		},
	});
	assert.equal(await h.boundary(err("429 insufficient_quota")), undefined);
	assert.match(h.warnings()[0], /^onward：这条规则只提醒，需要你自己处理$/);
	await h.emit("agent_start");
	await h.boundary(err("502 upstream"));
	assert.deepEqual(h.sent, ["继续"]);
});

test("stop 规则里的键拼错了：整份设置不生效，额度错误不会落到兜底去续跑", async () => {
	const h = harness({
		config: {
			delay: "0s",
			rules: [{ name: "quota", when: { error: "quota" }, acton: "stop" }, { name: "any" }],
		},
	});
	await h.emit("session_start", { reason: "startup" });
	assert.match(h.warnings()[0], /onward\.json 有 1 处问题，修好之前不会自动续跑/);
	assert.equal(await h.boundary(err("429 insufficient_quota")), undefined);
	assert.equal(await h.boundary(err("502 upstream")), undefined);
	assert.deepEqual(h.sent, []);
	assert.match(await h.command("show rules"), /^设置文件有 1 处问题[\s\S]*- rules\[0\]（quota）\.acton 不认识/);
});

test("空回复：when.empty 的规则发「继续」，提示里说是空回复；空回复不算恢复，次数照算", async () => {
	const h = harness({ config: { delay: "0s", rules: [{ name: "empty", when: { empty: true }, maxRetries: 2 }] } });
	assert.equal((await h.boundary(empty()))?.continue, true);
	assert.match(h.notes.at(-1)![1], /^onward：空回复，0 毫秒后发「继续」$/);
	assert.equal((await h.boundary(empty()))?.continue, true);
	assert.equal(await h.boundary(empty()), undefined);
	assert.deepEqual(h.sent, ["继续", "继续"]);
	assert.match(h.warnings()[0], /已续跑 2 次仍未恢复/);
});

test("空回复：没有 when.empty 的规则时不处理，不带 when 的兜底也不管", async () => {
	const h = harness(fast());
	assert.equal(await h.boundary(empty()), undefined);
	assert.deepEqual(h.sent, []);
});

test("静默重发之后收到空回复：接着发「继续」，不当成已经恢复", async () => {
	const h = harness({
		config: {
			delay: "0s",
			rules: [
				{ name: "auth", when: { error: "401" }, action: "resend", maxRetries: 1 },
				{ name: "empty", when: { empty: true } },
			],
		},
	});
	assert.equal((await h.boundary(err("401 Invalid API key")))?.continue, true);
	assert.equal((await h.boundary(empty()))?.continue, true);
	assert.deepEqual(h.sent, ["继续"]);
	// 空回复不算恢复：auth 用过的次数还在，再来 401 就到上限。
	assert.equal(await h.boundary(err("401 Invalid API key")), undefined);
	assert.match(h.warnings()[0], /已续跑 1 次仍未恢复/);
});
