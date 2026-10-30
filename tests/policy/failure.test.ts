import assert from "node:assert/strict";
import { test } from "node:test";
import { errorSignature, isEmptyReply, isFailure, isSuccess, normalizeError } from "../../src/policy/failure.ts";
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

test("签名忽略大小写与多余空白，区分不同错误；空回复是同一个「空回复」", () => {
	assert.equal(errorSignature(err("401  Invalid   API key")), errorSignature(err("401 Invalid API Key")));
	assert.notEqual(errorSignature(err("401 Invalid API key")), errorSignature(err("429 rate limited")));
	assert.equal(errorSignature(err("", { errorMessage: undefined })), "未知错误");
	assert.equal(errorSignature(empty()), "空回复");
});

test("中转每次换 request id 时仍是同一个错误", () => {
	const relay = (id: string) =>
		`401 {"error":{"message":"Invalid token (request id: 20261027${id})","type":"new_api_error"}}`;
	assert.equal(
		errorSignature(err(relay("0549250583148d9d6ckwpiDrD"))),
		errorSignature(err(relay("0549250583148d9d6ckwpiDrE"))),
	);
	assert.equal(normalizeError("id 550e8400-e29b-41d4-a716-446655440000 done"), "id uuid done");
	assert.equal(normalizeError("ts 1793077241844 ok"), "ts num ok");
	assert.equal(normalizeError("trace deadbeefcafe1234 x"), "trace id x");
});
