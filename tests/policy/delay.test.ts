import assert from "node:assert/strict";
import { test } from "node:test";
import { delayText, formatDelay, parseDelay, retryDelay, totalDelay } from "../../src/policy/delay.ts";

const ramp = { kind: "ramp", step: 3_000, cap: 15_000 } as const;

test("按次增长并封顶：3s..15s 是 3s → 6s → 9s → 12s → 15s → 15s", () => {
	assert.deepEqual(parseDelay("3s..15s"), ramp);
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6, 10].map((n) => retryDelay(n, ramp)),
		[3_000, 6_000, 9_000, 12_000, 15_000, 15_000, 15_000],
	);
	assert.equal(totalDelay(10, ramp), 120_000);
	assert.equal(totalDelay(50, ramp), 30_000 + 46 * 15_000);
});

test("列表按顺序等，最后一个值重复；一个值就是每次都等这么久", () => {
	const list = parseDelay("5s, 10s ,30s");
	assert.deepEqual(list, { kind: "list", steps: [5_000, 10_000, 30_000] });
	assert.deepEqual(
		[1, 3, 9].map((n) => retryDelay(n, list as never)),
		[5_000, 30_000, 30_000],
	);
	assert.deepEqual(parseDelay("0s"), { kind: "list", steps: [0] });
	assert.deepEqual(parseDelay("500ms,1.5s,2m"), { kind: "list", steps: [500, 1_500, 120_000] });
});

test("每个值都要带单位，超过一小时、写反了的起步封顶、太长的列表都不收", () => {
	for (const bad of ["5", "5s,10", "", "5x", "61m", "15s..3s", "0s..15s", "3s..", "..15s", "3s..15s..20s"])
		assert.equal(typeof parseDelay(bad), "string", bad);
	assert.match(parseDelay(Array(21).fill("1s").join(",")) as string, /最多 20 个/);
});

test("写回的样子和给人看的样子", () => {
	assert.equal(delayText(ramp), "3s..15s");
	assert.equal(
		delayText({ kind: "list", steps: [30_000, 60_000, 120_000, 1_500, 250, 0] }),
		"30s,1m,2m,1.5s,250ms,0s",
	);
	assert.equal(formatDelay(20), "20 毫秒");
	assert.equal(formatDelay(1_500), "1.5 秒");
	assert.equal(formatDelay(15_000), "15 秒");
	assert.equal(formatDelay(150_000), "2 分 30 秒");
	assert.equal(formatDelay(120_000), "2 分");
});
