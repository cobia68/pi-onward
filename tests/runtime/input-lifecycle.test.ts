import assert from "node:assert/strict";
import { test } from "node:test";
import { inputSession } from "../support/input-session.ts";

for (const providerFirst of [false, true]) {
	test(`实际进入任务的改写文本用于续跑，输入扩展先加载=${providerFirst}`, async (t) => {
		const h = await inputSession({
			providerFirst,
			extension: (pi) => {
				pi.on("input", (event) =>
					event.text === "alias" ? { action: "transform", text: "Actual accepted task" } : undefined,
				);
			},
		});
		t.after(() => h.cleanup());
		await h.session.prompt("alias");
		assert.deepEqual(h.inputs[0], ["Actual accepted task"]);
		assert.deepEqual(h.continuations(), ["Retry: Actual accepted task"]);
	});

	test(`被接管的输入不覆盖任务或重置失败预算，输入扩展先加载=${providerFirst}`, async (t) => {
		const h = await inputSession({
			providerFirst,
			maxFailures: 1,
			extension: (pi) => {
				pi.on("input", (event) => (event.text === "ping" ? { action: "handled" } : undefined));
			},
			beforeReply: async (session, request) => {
				if (request <= 2) await session.prompt("ping", { streamingBehavior: "steer" });
			},
			fails: (request) => request <= 2,
		});
		t.after(() => h.cleanup());
		await h.session.prompt("Original task");
		assert.deepEqual(h.continuations(), ["Retry: Original task"]);
		assert.equal(h.requests, 2, "接管 ping 不能重新获得失败预算");
	});
}

test("自动用户消息不覆盖任务来源，重载后仍从会话记录恢复任务", async (t) => {
	const h = await inputSession({ fails: (request) => request % 2 === 1 });
	t.after(() => h.cleanup());
	await h.session.prompt("Original task");
	await h.session.prompt("First automatic continuation", { source: "extension" });
	const oldBranch = h.manager.getLeafId()!;
	await h.session.reload();
	await h.session.prompt("Second automatic continuation", { source: "extension" });
	assert.deepEqual(h.continuations(), Array(3).fill("Retry: Original task"));
	await h.session.prompt("New task", { source: "rpc" });
	assert.equal(h.continuations().at(-1), "Retry: New task");
	await h.session.navigateTree(oldBranch, { summarize: false });
	await h.session.prompt("Branch automatic continuation", { source: "extension" });
	assert.equal(h.continuations().at(-1), "Retry: Original task");
	for (const entry of h.manager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "onward.input") continue;
		assert.deepEqual(
			Object.keys(entry.data as object).sort(),
			["source", "timestamp"],
			"来源记录不重复保存提示词正文",
		);
	}
});

test("排队后被拦截的输入不覆盖已接收的改写任务", async (t) => {
	const h = await inputSession({
		extension: (pi) => {
			pi.on("input", (event) => {
				if (event.text === "alias") return { action: "transform", text: "New queued task" };
				if (event.text === "ping") return { action: "handled" };
			});
		},
		beforeReply: async (session, request) => {
			if (request === 1) {
				await session.steer("alias");
				await session.steer("ping");
			}
		},
		fails: (request) => request <= 2,
	});
	t.after(() => h.cleanup());
	await h.session.prompt("Original task");
	assert.deepEqual(h.inputs[1], ["Original task", "New queued task"]);
	assert.deepEqual(h.continuations(), ["Retry: New queued task"]);
});

test("排队的自动消息经改写后仍保留原任务和失败预算", async (t) => {
	const h = await inputSession({
		maxFailures: 1,
		extension: (pi) => {
			pi.on("input", (event) =>
				event.source === "extension" ? { action: "transform", text: "Automatic rewritten" } : undefined,
			);
		},
		beforeReply: async (session, request) => {
			if (request === 2) await session.followUp("Automatic raw", undefined, { source: "extension" });
		},
		fails: (request) => request <= 3,
	});
	t.after(() => h.cleanup());
	await h.session.prompt("Original task");
	assert.deepEqual(h.continuations(), ["Retry: Original task"]);
	assert.equal(h.requests, 3, "自动队列输入不能重置失败预算");
});

test("已排队但取消的输入不会成为新任务，后续恢复仍使用原任务", async (t) => {
	const h = await inputSession({
		beforeReply: async (session, request) => {
			if (request === 1) {
				await session.steer("Discarded task");
				session.clearQueue();
			}
		},
	});
	t.after(() => h.cleanup());
	await h.session.prompt("Original task");
	assert.deepEqual(h.continuations(), ["Retry: Original task"]);
});

test("同文的人工与自动排队输入无法判定来源时，不猜测任务或重置预算", async (t) => {
	const h = await inputSession({
		maxFailures: 1,
		beforeReply: async (session, request) => {
			if (request === 1) {
				await session.steer("Same text");
				await session.followUp("Same text", undefined, { source: "extension" });
			}
		},
		fails: (request) => request <= 3,
	});
	t.after(() => h.cleanup());
	await h.session.prompt("Original task");
	assert.deepEqual(h.continuations(), []);
	assert.equal(h.requests, 3);
});

test("被接管的人工文本与改写后的自动消息同文时，不能误判成人工新任务", async (t) => {
	const h = await inputSession({
		extension: (pi) => {
			pi.on("input", (event) => {
				if (event.text === "Handled human") return { action: "handled" };
				if (event.text === "Automatic raw") return { action: "transform", text: "Handled human" };
			});
		},
		beforeReply: async (session, request) => {
			if (request === 1) {
				await session.steer("Handled human");
				await session.followUp("Automatic raw", undefined, { source: "extension" });
			}
		},
		fails: (request) => request <= 2,
	});
	t.after(() => h.cleanup());
	await h.session.prompt("Original task");
	assert.deepEqual(h.continuations(), []);
	assert.equal(h.requests, 2);
});

test("用户消息最终改写后的正文在续跑和重载中一致", async (t) => {
	const h = await inputSession({
		fails: (request) => request % 2 === 1,
		extension: (pi) => {
			pi.on("message_end", (event) =>
				event.message.role === "user"
					? { message: { ...event.message, content: [{ type: "text", text: "Final task text" }] } }
					: undefined,
			);
		},
	});
	t.after(() => h.cleanup());
	await h.session.prompt("Raw task");
	await h.session.reload();
	await h.session.prompt("Automatic continuation", { source: "extension" });
	assert.deepEqual(h.continuations(), ["Retry: Final task text", "Retry: Final task text"]);
});
