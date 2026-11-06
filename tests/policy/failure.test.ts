import assert from "node:assert/strict";
import { test } from "node:test";
import { failureText, isEmptyReply, isFailure, isSuccess } from "../../src/policy/failure.ts";
import { aborted, assistant, empty, err, ok } from "../support/fake-pi.ts";

const user = { role: "user", content: "hi", timestamp: 0 } as const;
const text = (value: string) => ({ type: "text", text: value }) as const;
const call = { type: "toolCall", id: "t1", name: "read", arguments: {} } as const;

test("正常返回算恢复：包括工具轮；出错、空回复、Esc、用户消息不算", () => {
	for (const stopReason of ["stop", "length", "toolUse", "deferred"] as const)
		assert.equal(isSuccess(assistant({ stopReason, content: [text("x")] })), true, stopReason);
	assert.equal(isSuccess(ok()), true);
	assert.equal(isSuccess(err()), false);
	assert.equal(isSuccess(empty()), false, "空回复不算恢复");
	assert.equal(isSuccess(aborted()), false);
	assert.equal(isSuccess(assistant({ stopReason: "pending" })), false);
	assert.equal(isSuccess(user), false);
});

test("空回复：正常结束（stop），但没有文字也没有工具调用；只有空白或只有思考也算", () => {
	assert.equal(isEmptyReply(empty()), true);
	assert.equal(isEmptyReply(empty({ content: [text("  \n")] })), true);
	assert.equal(isEmptyReply(empty({ content: [{ type: "thinking", thinking: "想了想" }] })), true);
	assert.equal(isEmptyReply(ok()), false);
	assert.equal(isEmptyReply(empty({ content: [call] })), false, "工具调用不算空");
	assert.equal(isEmptyReply(assistant({ stopReason: "length" })), false, "只算 stop");
	assert.equal(isEmptyReply(err()), false);
	assert.equal(isEmptyReply(aborted()), false);
	assert.equal(isEmptyReply(user), false);
	assert.equal(isEmptyReply(undefined), false);
});

test("算失败的：stopReason=error 的助手消息和空回复；Esc 不算", () => {
	assert.equal(isFailure(err()), true);
	assert.equal(isFailure(empty()), true);
	assert.equal(isFailure(ok()), false);
	assert.equal(isFailure(aborted()), false);
	assert.equal(isFailure(user), false);
	assert.equal(isFailure(undefined), false, "上下文里没有消息");
});

test("普通错误原文保留，缺少文案时用未知错误，空回复用空串", () => {
	const raw = "401  Invalid API key (request id: 123)";
	assert.equal(failureText(err(raw)), raw);
	assert.equal(failureText(err("", { errorMessage: undefined })), "未知错误");
	assert.equal(failureText(err("  \n")), "未知错误");
	assert.equal(failureText(empty()), "");
});
