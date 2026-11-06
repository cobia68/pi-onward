import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActionDefinition, provideAction } from "../../src/actions/protocol.ts";
import { ActionRegistry } from "../../src/actions/registry.ts";
import { err, harness, rule, stage } from "../support/fake-pi.ts";

const action = (name = "test.record", phase: "boundary" | "settled" = "boundary"): ActionDefinition =>
	phase === "boundary"
		? {
				name,
				description: "测试动作",
				phase,
				modes: ["tui", "rpc"],
				parameters: {
					type: "object",
					required: ["value"],
					additionalProperties: false,
					properties: { value: { type: "integer" } },
				},
				execute: (params, context) => ({
					kind: "continue",
					entries: [
						{
							type: "custom_message",
							customType: "test",
							content: `${params.value}:${context.failures}`,
							display: false,
						},
					],
				}),
			}
		: {
				name,
				description: "测试落定动作",
				phase,
				modes: ["tui"],
				parameters: { type: "object", additionalProperties: false },
				execute: (_params, _context) => ({ kind: "completed", message: "done" }),
			};

test("动作提供者不依赖加载顺序，发现后可校验并执行参数", async () => {
	for (const providerFirst of [true, false]) {
		const h = harness({
			providerFirst,
			actions: [action()],
			config: { rules: [rule([stage(1, "test.record", { value: 7 })])] },
		});
		await h.emit("session_start", { reason: "startup" });
		assert.equal((await h.boundary(err()))?.continue, true);
		assert.deepEqual(h.sent, ["7:1"]);
		assert.match(await h.command("actions"), /test\.record/);
	}
});

test("参数无效会在配置加载时阻断整个配置", async () => {
	const h = harness({
		config: {
			rules: [{ name: "bad", stages: [{ minFailures: 1, action: { use: "test.record", with: { value: "x" } } }] }],
		},
		actions: [action()],
	});
	await h.emit("session_start", { reason: "startup" });
	assert.match(h.warnings()[0] ?? "", /配置有 .*处问题/);
	assert.equal(
		await h.boundary({
			role: "assistant",
			stopReason: "error",
			errorMessage: "boom",
			provider: "p",
			model: "m",
			content: [],
		}),
		undefined,
	);
});

test("动作参数校验错误使用英文并包含动作名称", () => {
	const h = harness({ actions: [action()] });
	const registry = new ActionRegistry();
	registry.discover(h.pi, []);
	assert.equal(registry.check({ use: "missing.action" }), "Action missing.action is not loaded or failed to register");
	const problem = registry.check({ use: "test.record", with: { value: "x" } });
	assert.ok(problem);
	assert.match(problem, /^Invalid parameters for test\.record: /);
	assert.doesNotMatch(problem, /\p{Script=Han}/u);
});

test("重复动作名称不会静默覆盖", () => {
	const h = harness({ actions: [action(), action()] });
	const registry = new ActionRegistry();
	const pi = h.pi;
	registry.discover(pi, []);
	assert.equal(registry.list().length, 0);
});

test("未引用动作的注册错误只警告，不阻断内置恢复；静默启动也不隐藏诊断", async () => {
	const h = harness({
		actions: [{ ...action("unused.broken"), parameters: { type: "object", unknownKeyword: true } }],
		config: { quietStartup: true, rules: [rule()] },
	});
	await h.emit("session_start", { reason: "startup" });
	assert.equal((await h.boundary(err()))?.continue, true);
	assert.ok(h.warnings().some((message) => /动作注册/.test(message)));
	assert.doesNotMatch(await h.command("show"), /配置无效/);
	assert.match(await h.command("actions"), /Action unused\.broken registration failed:[^\n]*unknownKeyword/);
});

test("重名动作只隔离冲突名称，引用冲突动作的配置仍然整体拒绝", async () => {
	for (const referenced of [false, true]) {
		const h = harness({
			actions: [action(), action()],
			config: { rules: [rule(referenced ? [stage(1, "test.record", { value: 1 })] : [stage()])] },
		});
		await h.emit("session_start", { reason: "startup" });
		assert.equal(!!(await h.boundary(err()))?.continue, !referenced);
		assert.match(await h.command("actions"), /test\.record[^\n]*Duplicate action name/);
		assert.equal(/配置无效/.test(await h.command("show")), referenced);
		assert.deepEqual(h.sent, []);
	}
});

test("外部动作可以在 Pi 事件发现中注册，session_shutdown 后取消订阅", async () => {
	const h = harness({ config: { rules: [rule([stage(1, "test.once")])] } });
	let calls = 0;
	const definition: ActionDefinition = {
		...action("test.once", "settled"),
		execute: () => {
			calls++;
			return { kind: "completed" as const };
		},
	};
	const dispose = provideAction(h.pi, definition);
	await h.emit("session_start", { reason: "startup" });
	assert.match(await h.command("actions"), /test\.once/);
	dispose();
	await h.boundary(err());
	assert.equal(calls, 0);
	assert.match(await h.command("status"), /Action provider has been unloaded/);
	await h.emit("session_shutdown", { reason: "reload" });
	const registry = new ActionRegistry();
	registry.discover(h.pi, []);
	assert.deepEqual(registry.list(), []);
});

test("异步或坏 Schema 不进入可执行注册表，不静默接受未知参数", async () => {
	for (const parameters of [
		{ type: "object", $async: true },
		{ type: "object", unknownKeyword: true },
		{ type: "object", properties: { value: { type: "string", pattern: "[" } } },
	]) {
		const h = harness({
			actions: [{ ...action(), parameters }],
			config: { rules: [rule([stage(1, "test.record")])] },
		});
		await h.emit("session_start", { reason: "startup" });
		assert.match(await h.command("status"), /配置无效/);
		assert.equal(await h.boundary(err()), undefined);
	}
});
