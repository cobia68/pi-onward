import assert from "node:assert/strict";
import { test } from "node:test";
import { errorSignature, isFailure, isSuccess, normalizeError } from "../../src/policy/failure.ts";
import { aborted, assistant, err, ok } from "../support/fake-pi.ts";

const user = { role: "user", content: "hi", timestamp: 0 } as const;

test("正常返回算恢复：包括工具轮；出错、Esc、用户消息不算", () => {
	for (const stopReason of ["stop", "length", "toolUse", "deferred"] as const)
		assert.equal(isSuccess(assistant({ stopReason })), true, stopReason);
	assert.equal(isSuccess(ok()), true);
	assert.equal(isSuccess(err()), false);
	assert.equal(isSuccess(aborted()), false);
	assert.equal(isSuccess(assistant({ stopReason: "pending" })), false);
	assert.equal(isSuccess(user), false);
});

test("只有 stopReason=error 的助手消息算失败；Esc 不算", () => {
	assert.equal(isFailure(err()), true);
	assert.equal(isFailure(aborted()), false);
	assert.equal(isFailure(user), false);
	assert.equal(isFailure(undefined), false, "上下文里没有消息");
});

test("签名忽略大小写与多余空白，区分不同错误", () => {
	assert.equal(errorSignature(err("401  Invalid   API key")), errorSignature(err("401 Invalid API Key")));
	assert.notEqual(errorSignature(err("401 Invalid API key")), errorSignature(err("429 rate limited")));
	assert.equal(errorSignature(err("", { errorMessage: undefined })), "未知错误");
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
