import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionDefinition, SettledActionContext } from "../../src/actions/protocol.ts";
import { aborted, boundaryEvent, empty, err, harness, ok, rule, stage, tool } from "../support/fake-pi.ts";

const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });

test("第三次失败进入接管阶段；前两次续跑，接管只执行一次且晚于所有 settled 观察者", async () => {
	const calls: SettledActionContext[] = [];
	const action: ActionDefinition = {
		name: "test.takeover",
		description: "接管",
		phase: "settled",
		modes: ["tui"],
		handoff: true,
		parameters: { type: "object", additionalProperties: false },
		execute: (_params, ctx) => {
			calls.push(ctx);
			return { kind: "handoff", message: "接管已接受" };
		},
	};
	const h = harness({ config: { rules: [rule([stage(), stage(3, "test.takeover")])] }, actions: [action] });
	h.pi.on("agent_settled", () => {
		assert.equal(calls.length, 0);
		h.trace.push("last-observer");
	});
	await start(h);
	assert.equal((await h.boundary(err()))?.continue, true);
	assert.equal((await h.boundary(err()))?.continue, true);
	assert.equal(await h.boundary(err()), undefined);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.failures, 3);
	assert.equal(calls[0]?.minFailures, 3);
	assert.equal(Object.hasOwn(calls[0]!, "fromFailure"), false);
	assert.equal(calls[0]?.chain.handoffs, 1);
	assert.equal(calls[0]?.host.isIdle(), true);
	assert.deepEqual(h.trace, ["last-observer", "command:onward"]);
	await h.command(h.dispatches[0]!.slice("/onward ".length));
	assert.equal(calls.length, 1, "重复内部派发不能重放");
	assert.match(await h.command("status"), /连续失败\s+3 次[\s\S]*已启动续跑\s+2 次[\s\S]*已接管/);
});

test("delay 按 minFailures 计算阶段内序号，不沿用前一阶段的次数", async () => {
	const h = harness({ config: { rules: [rule([stage(), stage(3, "pi.message", undefined, "1ms,2ms")])] } });
	await start(h);
	for (let failure = 1; failure <= 2; failure++) await h.boundary(err());
	const noteCount = h.notes.length;
	for (let failure = 3; failure <= 5; failure++) await h.boundary(err());
	const waits = h.notes
		.slice(noteCount)
		.map(([, text]) => text)
		.filter((text) => text.includes("后执行 pi.message"));
	assert.deepEqual(waits, [
		"onward：1 毫秒后执行 pi.message（连续失败 3 次）",
		"onward：2 毫秒后执行 pi.message（连续失败 4 次）",
		"onward：2 毫秒后执行 pi.message（连续失败 5 次）",
	]);
});

test("消息续跑保留先前提议；只把正文和明确变量发给模型", async () => {
	const h = harness({
		config: { rules: [rule([stage(), stage(2, "pi.message", { prompt: "第 {failures} 次：{error}\n{rule}" })])] },
	});
	await start(h);
	const prior = { type: "custom", customType: "other", data: {} };
	const result = await h.emit("agent_before_settle", boundaryEvent(err(), "a", { entries: [prior] }));
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 2);
	assert.deepEqual(result.entries[0], prior);
	assert.equal(result.entries[1].type, "custom_message");
	assert.equal(result.entries[1].content, "继续");
	assert.doesNotMatch(await h.command("status"), /已启动续跑/);
	await h.emit("agent_start");
	await h.boundary(empty(), "b");
	assert.deepEqual(h.sent, ["第 2 次：空回复\nserver"]);
});

test("空回复不清零，换错误和换规则也不清零；正常工具轮清零", async () => {
	const h = harness({
		config: {
			rules: [
				{ ...rule([stage()], "network"), when: { failure: "network" } },
				rule([stage(), stage(3, "onward.stop")], "other"),
			],
		},
	});
	await start(h);
	await h.boundary(err("network"));
	await h.boundary(empty());
	await h.boundary(err("502"));
	assert.match(await h.command("status"), /连续失败\s+3 次/);
	await h.emit("message_end", { message: tool() });
	assert.equal(h.status(), undefined);
	assert.equal((await h.boundary(err("502")))?.continue, true);
	assert.match(await h.command("status"), /连续失败\s+1 次/);
});

test("正常回复、用户取消、他人已请求继续和排队用户消息均不插入恢复", async () => {
	const h = harness();
	await start(h);
	for (const message of [ok(), aborted()]) assert.equal(await h.boundary(message), undefined);
	assert.equal(await h.emit("agent_before_settle", boundaryEvent(err(), "b", { continue: true })), undefined);
	h.pending = 1;
	assert.equal(await h.boundary(err()), undefined);
	assert.deepEqual(h.dispatches, []);
	assert.deepEqual(h.sent, []);
});

test("按 Esc、关闭、重载或新用户输入取消等待，旧等待不能覆盖新状态", async () => {
	for (const cancel of ["abort", "off", "reload", "input"] as const) {
		const h = harness({ config: { rules: [rule([{ ...stage(), delay: "5s" }])] } });
		await start(h);
		const waiting = h.boundary(err());
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (cancel === "abort") h.controller.abort();
		else if (cancel === "input") await h.user("new task");
		else await h.command(cancel);
		assert.equal(await waiting, undefined, cancel);
		assert.deepEqual(h.sent, []);
		assert.deepEqual(h.dispatches, []);
		if (cancel !== "abort") assert.equal(h.status(), undefined);
	}
});

test("落定前新的续跑或用户取消使待执行动作失效", async () => {
	let calls = 0;
	const action: ActionDefinition = {
		name: "test.external",
		description: "external",
		phase: "settled",
		modes: ["tui"],
		parameters: { type: "object" },
		execute: () => {
			calls++;
			return { kind: "completed" };
		},
	};
	for (const event of ["agent_start", "input", "session_shutdown"] as const) {
		const h = harness({ config: { rules: [rule([stage(1, action.name)])] }, actions: [action] });
		await start(h);
		await h.emit("agent_before_settle", boundaryEvent(err()));
		if (event === "input") await h.user("new task");
		else await h.emit(event, { reason: "reload" });
		await h.emit("agent_settled", { aborted: false });
		assert.equal(calls, 0, event);
	}
});

test("重复失败事件只计一次；同会话重复加载只由一个实例执行", async () => {
	const h = harness({ copies: 2, config: { maxFailures: 2, rules: [rule([stage(1, "pi.message")])] } });
	await start(h);
	await h.boundary(err(), "a");
	await h.boundary(err(), "a");
	await h.boundary(err(), "b");
	await h.boundary(err(), "c");
	assert.deepEqual(h.sent, ["继续", "继续"]);
	assert.equal(h.warnings().length, 1);
});

test("自动消息保留本轮失败预算，人工任务重新计数", async () => {
	const h = harness({ config: { maxFailures: 1, rules: [rule()] } });
	await start(h);
	await h.boundary(err());
	await h.user("continue", "extension");
	assert.equal(await h.boundary(err()), undefined);
	assert.match(await h.command("status"), /超过 1 次上限/);
	await h.user("new task");
	assert.equal((await h.boundary(err()))?.continue, true);
});

test("没有 UI 的 print/RPC 通过消息模板重发任务提示词", async () => {
	for (const mode of ["print", "json", "rpc"] as const) {
		const h = harness({
			mode,
			ui: false,
			config: { rules: [rule([stage(1, "pi.message", { prompt: "{taskPrompt}" })])] },
		});
		await start(h);
		await h.user("检查当前任务", "rpc");
		assert.equal((await h.boundary(err()))?.continue, true);
		assert.deepEqual(h.sent, ["检查当前任务"]);
		assert.deepEqual(h.notes, []);
		assert.equal(h.statusWrites, 0);
	}
});
