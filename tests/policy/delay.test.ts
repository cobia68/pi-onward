import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDelay, MAX_DELAY_MS, parseDuration, retryDelay, totalDelay } from "../../src/policy/delay.ts";

const ramp = { retryDelaysMs: [], retryBaseMs: 3_000, retryCapMs: 15_000 };

test("默认按次数增长并封顶：3s → 6s → 9s → 12s → 15s → 15s", () => {
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6, 10].map((n) => retryDelay(n, ramp)),
		[3_000, 6_000, 9_000, 12_000, 15_000, 15_000, 15_000],
	);
	assert.equal(totalDelay(10, ramp), 120_000);
	assert.equal(totalDelay(50, ramp), 30_000 + 46 * 15_000);
});

test("写死列表时优先，最后一个值重复", () => {
	const list = { retryDelaysMs: [5_000, 10_000, 30_000], retryBaseMs: 1, retryCapMs: 2 };
	assert.deepEqual(
		[1, 3, 9].map((n) => retryDelay(n, list)),
		[5_000, 30_000, 30_000],
	);
});

test("间隔写法解析与显示", () => {
	assert.equal(parseDuration("500ms"), 500);
	assert.equal(parseDuration("5s"), 5_000);
	assert.equal(parseDuration("5"), 5_000);
	assert.equal(parseDuration("2m"), 120_000);
	assert.equal(parseDuration("99m"), MAX_DELAY_MS);
	assert.equal(parseDuration("5x"), undefined);
	assert.equal(formatDelay(20), "20 毫秒");
	assert.equal(formatDelay(1_500), "1.5 秒");
	assert.equal(formatDelay(15_000), "15 秒");
	assert.equal(formatDelay(150_000), "2 分 30 秒");
	assert.equal(formatDelay(120_000), "2 分");
});
