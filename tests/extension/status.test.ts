// 状态栏：续跑时写第几次，停了写明，恢复或用户发新消息时清掉。
import assert from "node:assert/strict";
import { test } from "node:test";
import { err, harness, ok } from "../support/fake-pi.ts";

const fast = (params: Record<string, unknown> = {}, rules: unknown[] = [{ name: "any" }]) => ({
	config: { delay: "0s", ...params, rules },
});

test("续跑时写第几次和规则名；续跑之后正常返回就清掉", async () => {
	const h = harness(fast({ maxRetries: 3 }));
	await h.boundary(err());
	assert.equal(h.status(), "⏩ 续跑 1/3 · any");
	await h.boundary(err("502 upstream"));
	assert.equal(h.status(), "⏩ 续跑 2/3 · any");
	await h.emit("message_end", { message: ok() });
	assert.equal(h.status(), undefined);
});

test("次数用完：写续跑已停，这一轮结束也留着，用户发新消息时清掉", async () => {
	const h = harness(fast({ maxRetries: 1 }));
	await h.boundary(err());
	await h.boundary(err("502 upstream"));
	assert.equal(h.status(), "⏩ 续跑已停 · any");
	await h.emit("agent_start");
	assert.equal(h.status(), undefined);
});

test("action=stop 的规则：写不续跑", async () => {
	const h = harness(fast({}, [{ name: "quota", when: { error: "quota" }, action: "stop" }]));
	await h.boundary(err("429 insufficient_quota"));
	assert.equal(h.status(), "⏩ 不续跑 · quota");
});

test("没有接着跑：按 Esc 打断等待、关掉，都清掉", async () => {
	const esc = harness(fast({ delay: "200ms" }));
	const waiting = esc.boundary(err());
	setTimeout(() => esc.controller.abort(), 20);
	await waiting;
	assert.equal(esc.status(), undefined);

	const off = harness(fast({ delay: "5s" }));
	const stopped = off.boundary(err());
	setTimeout(() => off.command("off"), 20);
	await stopped;
	assert.equal(off.status(), undefined);
});

test("没有界面时不写状态栏；没续跑过也不去清", async () => {
	const h = harness({ ...fast(), ui: false });
	await h.boundary(err());
	assert.equal(h.statusWrites, 0);
	const idle = harness(fast());
	await idle.emit("agent_start");
	await idle.emit("message_end", { message: ok() });
	assert.equal(idle.statusWrites, 0);
});
