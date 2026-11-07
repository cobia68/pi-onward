import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionDefinition, SettledActionContext, TerminalResult } from "../../src/actions/protocol.ts";
import { boundaryEvent, err, harness, rule, stage } from "../support/fake-pi.ts";

type SettledDefinition = Extract<ActionDefinition, { phase: "settled" }>;
const external = (execute: SettledDefinition["execute"]): SettledDefinition => ({
	name: "test.external",
	description: "外部动作",
	phase: "settled",
	modes: ["tui"],
	parameters: { type: "object", additionalProperties: false },
	execute,
});
const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });

test("已有扩展命令只分派一次，原样保留参数且不送给模型", async () => {
	const h = harness({
		config: { rules: [rule([stage(1, "pi.command", { name: "fixture", args: '--dry-run -- 接着做 "任务"' })])] },
	});
	const calls: string[] = [];
	h.pi.registerCommand("fixture", {
		handler: async (args, ctx) => {
			assert.equal(ctx.isIdle(), true);
			calls.push(args);
		},
	});
	await start(h);
	await h.boundary(err());
	assert.deepEqual(calls, ['--dry-run -- 接着做 "任务"']);
	assert.deepEqual(h.sent, []);
	assert.match(await h.command("status"), /已分派，业务结果未知/);
	await h.emit("agent_settled", { aborted: false });
	assert.equal(calls.length, 1);
});

test("不存在、内置或自调用命令明确失败，不降级为普通提示词", async () => {
	for (const name of ["missing", "model", "onward", "onward:2"]) {
		const h = harness({ config: { rules: [rule([stage(1, "pi.command", { name })])] } });
		await start(h);
		await h.boundary(err());
		assert.deepEqual(h.sent, []);
		assert.equal(h.dispatches.length, 1);
		assert.doesNotMatch(h.warnings().at(-1)!, /\p{Script=Han}/u);
		assert.match(await h.command("status"), /执行失败/);
	}
});

test("执行阶段和运行模式限制在动作调用前检查", async () => {
	let calls = 0;
	const h = harness({
		mode: "rpc",
		actions: [
			external(() => {
				calls++;
				return { kind: "completed" };
			}),
		],
		config: { rules: [rule([stage(1, "test.external")])] },
	});
	await start(h);
	await h.boundary(err());
	assert.equal(calls, 0);
	assert.deepEqual(h.dispatches, []);
	assert.match(await h.command("status"), /test\.external does not support rpc mode/);
});

test("异常、非法返回及超时均报告结果未知，不自动执行下一阶段或重放", async () => {
	for (const behavior of ["throw", "invalid", "timeout"] as const) {
		let calls = 0;
		let signal: AbortSignal | undefined;
		let complete: ((result: TerminalResult) => void) | undefined;
		const action = external((_params, ctx) => {
			calls++;
			signal = ctx.signal;
			if (behavior === "throw") throw new Error("partial side effect");
			if (behavior === "invalid") return undefined as never;
			return new Promise((resolve) => {
				complete = resolve;
			});
		});
		const h = harness({
			actions: [action],
			config: { actionTimeout: "15ms", rules: [rule([stage(1, action.name), stage(2, "pi.message")])] },
		});
		await start(h);
		await h.boundary(err());
		assert.match(h.warnings().at(-1)!, /Action (threw an exception|returned an invalid result|timed out)/);
		assert.doesNotMatch(h.warnings().at(-1)!, /\p{Script=Han}/u);
		assert.match(await h.command("status"), /结果未知/);
		await h.boundary(err());
		assert.equal(calls, 1);
		if (behavior === "timeout") {
			assert.equal(signal?.aborted, true);
			complete?.({ kind: "completed", message: "late" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.match(await h.command("status"), /结果未知/);
		}
	}
});

test("落定观察者中出现用户消息、关闭或重载时，已排队内部命令失效", async () => {
	for (const cancel of ["input", "off", "reload"] as const) {
		let calls = 0;
		const action = external(() => {
			calls++;
			return { kind: "completed" };
		});
		const h = harness({ actions: [action], config: { rules: [rule([stage(1, action.name)])] } });
		h.pi.on("agent_settled", async () => {
			if (cancel === "input") await h.user("new");
			else await h.command(cancel);
		});
		await start(h);
		await h.boundary(err());
		assert.equal(calls, 0, cancel);
		assert.deepEqual(h.sent, []);
	}
});

test("执行中的取消通知动作，迟到结果不覆盖新任务状态", async () => {
	let context: SettledActionContext | undefined;
	let finish: ((value: { kind: "completed" }) => void) | undefined;
	const action = external((_params, ctx) => {
		context = ctx;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const h = harness({ actions: [action], config: { rules: [rule([stage(1, action.name)])] } });
	await start(h);
	const work = h.boundary(err());
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(context);
	await h.user("new task");
	assert.equal(context.signal.aborted, true);
	finish?.({ kind: "completed" });
	await work;
	assert.equal(h.status(), undefined);
	assert.doesNotMatch(await h.command("status"), /已完成|结果未知|连续失败/);
});

test("恢复链在任一 session_start 顺序恢复，错误会话消息无效，上限不随新进程丢失", async () => {
	for (const before of [true, false]) {
		let calls = 0;
		const action: ActionDefinition = {
			...external(() => {
				calls++;
				return { kind: "handoff" };
			}),
			handoff: true,
		};
		const h = harness({ actions: [action], config: { maxHandoffs: 2, rules: [rule([stage(1, action.name)])] } });
		const restore = () =>
			h.pi.events.emit("onward:resume-recovery", {
				sessionId: h.ctx.sessionManager.getSessionId(),
				chain: { id: "chain", handoffs: 2, maxHandoffs: 3 },
			});
		if (before) restore();
		await start(h);
		if (!before) restore();
		h.pi.events.emit("onward:resume-recovery", {
			sessionId: "other",
			chain: { id: "wrong", handoffs: 0, maxHandoffs: 10 },
		});
		await h.user("continue", "extension");
		await h.boundary(err());
		assert.equal(calls, 0);
		assert.match(await h.command("status"), /达到跨会话接管上限 2 次/);
		await h.user("new");
		await h.boundary(err());
		assert.equal(calls, 1);
	}
});

test("maxHandoffs=0 禁止原生接管；动作失败不伪报接管成功", async () => {
	const action: ActionDefinition = { ...external(() => ({ kind: "failed", message: "条件不满足" })), handoff: true };
	const h = harness({ actions: [action], config: { maxHandoffs: 0, rules: [rule([stage(1, action.name)])] } });
	await start(h);
	await h.boundary(err());
	assert.match(await h.command("status"), /接管上限 0/);
	await h.command("set maxHandoffs=2");
	await h.boundary(err());
	assert.match(await h.command("status"), /执行失败/);
	assert.doesNotMatch(await h.command("status"), /跨会话接管/);
});

test("取消未执行的边界提议不计已启动次数", async () => {
	const h = harness();
	await start(h);
	await h.emit("agent_before_settle", boundaryEvent(err()));
	assert.doesNotMatch(await h.command("status"), /已启动续跑/);
	await h.emit("agent_settled", { aborted: false });
	await h.emit("agent_start");
	assert.doesNotMatch(await h.command("status"), /已启动续跑/);
});
