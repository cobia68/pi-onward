import assert from "node:assert/strict";
import { test } from "node:test";
import { aborted, boundaryEvent, err, harness, ok, tool } from "../support/fake-pi.ts";

const resend = (params: Record<string, unknown> = {}) => ({
	config: { action: "resend", delay: "0s", ...params, rules: [{ name: "any" }] },
});

test("边界上省略失败消息并要求重发，不追加消息", async () => {
	const h = harness(resend());
	const result = await h.emit("agent_before_settle", boundaryEvent(err(), "abc123"));
	assert.deepEqual(result, {
		entries: [{ type: "context_edit", targetId: "abc123", replacement: null }],
		continue: true,
	});
	assert.match(h.notes.at(-1)![1], /^onward：0 毫秒后静默重发$/);
});

test("保留其他扩展已经提出的条目", async () => {
	const h = harness(resend());
	const prior = { type: "custom", customType: "x" };
	const result = await h.emit("agent_before_settle", boundaryEvent(err(), "e1", { entries: [prior] }));
	assert.deepEqual(result.entries, [prior, { type: "context_edit", targetId: "e1", replacement: null }]);
});

test("别的扩展已经要求继续：不插手", async () => {
	const h = harness(resend());
	assert.equal(await h.emit("agent_before_settle", boundaryEvent(err(), "e1", { continue: true })), undefined);
});

test("continue 触发的 agent_start 不重置额度：连续 10 次后第 11 次停", async () => {
	const h = harness(resend());
	for (let i = 0; i < 10; i++) assert.ok((await h.boundary(err(), `e${i}`))?.continue, `第 ${i + 1} 次`);
	assert.equal(await h.boundary(err(), "e10"), undefined);
	assert.match(h.warnings()[0], /同一个错误已连续 11 次/);
});

test("换了错误连续计数清零", async () => {
	const h = harness(resend({ maxSameError: 3 }));
	for (let i = 0; i < 3; i++) assert.ok((await h.boundary(err(), `a${i}`))?.continue);
	assert.ok((await h.boundary(err("429 rate limited"), "b"))?.continue);
	assert.ok((await h.boundary(err(), "c"))?.continue);
});

test("静默重发成功后再出错：次数和同错计数都从头算", async () => {
	const h = harness(resend({ maxRetries: 2, maxSameError: 2 }));
	assert.ok((await h.boundary(err(), "a"))?.continue);
	assert.ok((await h.boundary(err(), "b"))?.continue);
	await h.emit("message_end", { message: tool() });
	assert.ok((await h.boundary(err(), "c"))?.continue, "不该撞上次数或同错上限");
	assert.equal(h.status(), "⏩ 续跑 1/2 · any", "次数从头算");
	assert.deepEqual(h.warnings(), []);
});

test("正常结束、Esc、关闭：不继续", async () => {
	const h = harness(resend());
	assert.equal(await h.emit("agent_before_settle", boundaryEvent(ok(), "x")), undefined);
	assert.equal(await h.emit("agent_before_settle", boundaryEvent(aborted(), "y")), undefined);
	await h.command("off");
	assert.equal(await h.emit("agent_before_settle", boundaryEvent(err())), undefined);
});

test("同一份设置里 resend 规则与 message 规则各走各的", async () => {
	const h = harness({
		config: {
			delay: "0s",
			rules: [
				{ name: "auth", when: { error: "401" }, action: "resend" },
				{ name: "rest", action: "message" },
			],
		},
	});
	const auth = await h.boundary(err("401 Invalid API key"));
	assert.equal(auth.entries[0].type, "context_edit");
	assert.deepEqual(h.sent, []);
	await h.boundary(err("502 upstream"));
	assert.deepEqual(h.sent, ["继续"]);
});
