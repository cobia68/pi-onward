import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../../src/extension/command.ts";

test("命令解析", () => {
	assert.deepEqual(parseCommand(""), { kind: "status" });
	assert.deepEqual(parseCommand(" status "), { kind: "status" });
	assert.deepEqual(parseCommand("--help"), { kind: "help" });
	assert.deepEqual(parseCommand("rules"), { kind: "rules" });
	assert.deepEqual(parseCommand("reload"), { kind: "reload" });
	assert.deepEqual(parseCommand("reset"), { kind: "reset" });
	assert.deepEqual(parseCommand("10"), { kind: "set", patch: { maxRetries: 10 } });
	assert.deepEqual(parseCommand("off"), { kind: "set", enabled: false, patch: {} });
	assert.deepEqual(parseCommand("on silent"), { kind: "set", enabled: true, patch: { mode: "silent" } });
	assert.deepEqual(parseCommand("same=3"), { kind: "set", patch: { sameErrorLimit: 3 } });
	assert.deepEqual(parseCommand("5s,10s,30s,1m"), {
		kind: "set",
		patch: { retryDelaysMs: [5000, 10000, 30000, 60000] },
	});
	assert.deepEqual(parseCommand("500ms 2s"), { kind: "set", patch: { retryDelaysMs: [500, 2000] } });
	assert.deepEqual(parseCommand("base=2s cap=20s"), { kind: "set", patch: { retryBaseMs: 2000, retryCapMs: 20000 } });
	assert.deepEqual(parseCommand("ramp"), { kind: "set", patch: { retryDelaysMs: [] } });
	assert.deepEqual(parseCommand("3 same=2 5s"), {
		kind: "set",
		patch: { maxRetries: 3, sameErrorLimit: 2, retryDelaysMs: [5000] },
	});
	assert.deepEqual(parseCommand("prompt=继续, 第 {attempt} 次"), {
		kind: "set",
		patch: { prompt: "继续, 第 {attempt} 次" },
	});
	for (const bad of ["prompt=", "foo", "5x", "base=abc", "base="]) assert.equal(parseCommand(bad).kind, "error", bad);
});

test("范围和设置文件一致", () => {
	assert.deepEqual(parseCommand("999"), { kind: "set", patch: { maxRetries: 50 } });
	assert.deepEqual(parseCommand("same=0"), { kind: "set", patch: { sameErrorLimit: 1 } });
	assert.deepEqual(parseCommand(`prompt=${"x".repeat(600)}`), { kind: "set", patch: { prompt: "x".repeat(500) } });
});
