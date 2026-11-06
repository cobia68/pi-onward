import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, err, harness, rule, stage, tool } from "../support/fake-pi.ts";

const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });
const config = (prompt: string, delay = "0s") => ({
	rules: [rule([stage(1, "onward.message", { prompt }, delay)])],
});
const userEntry = (content: unknown) => ({ type: "message", message: { role: "user", content } });

test("{taskPrompt} 可以单独使用或与正文拼接；与现有变量一起单次替换", async () => {
	const task = "修复 {error}、{taskPrompt}，保留 $& 和换行\n第二行";
	for (const [prompt, expected] of [
		["{taskPrompt}", task],
		["继续{taskPrompt}", `继续${task}`],
		[
			"第 {failures} 次，{rule}：{error}\n{taskPrompt}\n原任务：{taskPrompt}",
			`第 1 次，server：502\n${task}\n原任务：${task}`,
		],
	]) {
		const h = harness({ config: config(prompt!) });
		await start(h);
		await h.emit("input", { source: "interactive", text: task });
		const result = await h.boundary(err("502"));
		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 1);
		assert.equal(result.entries[0].type, "custom_message", "复制提示词只追加消息，不生成上下文删除操作");
		assert.deepEqual(h.sent, [expected]);
	}
});

test("连续失败、自动续跑和正常工具轮保持来源；人工和 RPC 新任务更新来源", async () => {
	const h = harness({ config: config("继续{taskPrompt}") });
	await start(h);
	await h.emit("input", { source: "interactive", text: "原任务" });
	await h.boundary(err());
	await h.boundary(empty());
	await h.emit("input", { source: "extension", text: "其他扩展的自动续跑" });
	await h.boundary(err());
	await h.emit("message_end", { message: tool() });
	await h.boundary(err());
	assert.deepEqual(h.sent, Array(4).fill("继续原任务"));
	for (const source of ["interactive", "rpc"]) {
		await h.emit("input", { source, text: `${source} 新任务` });
		await h.boundary(err());
		assert.equal(h.sent.at(-1), `继续${source} 新任务`);
	}
});

test("新会话可由扩展发起任务，之后的自动消息不覆盖来源", async () => {
	const h = harness({ config: config("{taskPrompt}") });
	await start(h);
	await h.emit("input", { source: "extension", text: "扩展发起的任务" });
	await h.boundary(err());
	await h.emit("input", { source: "extension", text: "继续" });
	await h.boundary(err());
	assert.deepEqual(h.sent, ["扩展发起的任务", "扩展发起的任务"]);
});

test("恢复会话和切换分支从当前分支提取用户文本，不选续跑消息或附件", async () => {
	const h = harness({ config: config("继续{taskPrompt}") });
	h.entries.push(
		userEntry("旧任务"),
		userEntry([
			{ type: "text", text: "分支任务" },
			{ type: "image", data: "not-prompt-text", mimeType: "image/png" },
			{ type: "text", text: "第二段" },
		]),
		{ type: "custom_message", customType: "pi-onward", content: "继续分支任务" },
	);
	await start(h);
	await h.boundary(err());
	assert.equal(h.sent.at(-1), "继续分支任务\n第二段");
	h.entries.splice(0, h.entries.length, userEntry("另一个分支"));
	await h.emit("session_tree");
	await h.boundary(err());
	assert.equal(h.sent.at(-1), "继续另一个分支");
	h.entries.splice(0);
	await h.emit("session_start", { reason: "new" });
	await h.boundary(err());
	assert.equal(h.sent.length, 2, "新会话不能复用旧会话的任务");
	assert.match(h.warnings().at(-1)!, /No task prompt is available to expand \{taskPrompt\}/);
});

test("缺少任务文本或新任务只有图片时明确失败，不发送占位符也不回退到旧任务", async () => {
	for (const imageOnly of [false, true]) {
		const h = harness({ config: config("请重试：{taskPrompt}") });
		if (imageOnly) {
			h.entries.push(
				userEntry("不应复用的旧任务"),
				userEntry([{ type: "image", data: "image", mimeType: "image/png" }]),
			);
		}
		await start(h);
		assert.equal(await h.boundary(err()), undefined);
		assert.deepEqual(h.sent, []);
		assert.match(h.warnings().at(-1)!, /No task prompt is available to expand \{taskPrompt\}/);
	}
});

test("替换值里的 {taskPrompt} 不会递归展开，未知变量仍是正文", async () => {
	const h = harness({ config: config("{error}\n{unknown}") });
	await start(h);
	await h.boundary(err("错误信息包含 {taskPrompt}"));
	assert.deepEqual(h.sent, ["错误信息包含 {taskPrompt}\n{unknown}"]);
});

test("等待期间新任务取消旧提议，后续失败使用新提示词", async () => {
	const h = harness({
		config: {
			rules: [
				{
					...rule([stage(1, "onward.message", { prompt: "继续{taskPrompt}" }, "5s")], "old"),
					when: { failure: "old" },
				},
				rule([stage(1, "onward.message", { prompt: "继续{taskPrompt}" })]),
			],
		},
	});
	await start(h);
	await h.emit("input", { source: "interactive", text: "旧任务" });
	const waiting = h.boundary(err("old"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	await h.emit("input", { source: "rpc", text: "新任务" });
	assert.equal(await waiting, undefined);
	assert.deepEqual(h.sent, []);
	await h.boundary(err());
	assert.deepEqual(h.sent, ["继续新任务"]);
});
