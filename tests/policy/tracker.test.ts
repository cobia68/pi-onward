import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePolicy } from "../../src/policy/policy.ts";
import { Tracker } from "../../src/policy/tracker.ts";
import { err } from "../support/fake-pi.ts";

test("同一个错误连续超过上限就停，只提醒一次；换错误重新数", () => {
	const tracker = new Tracker();
	const policy = resolvePolicy({ maxSameError: 3 });
	for (let i = 1; i <= 3; i++) assert.equal(tracker.next("r", err(), policy).retry, true);
	assert.equal(tracker.next("r", err("429"), policy).retry, true, "换错误不停");
	for (let i = 1; i <= 3; i++) assert.equal(tracker.next("r", err(), policy).retry, true);
	assert.deepEqual(tracker.next("r", err(), policy), {
		retry: false,
		reason: "same-error",
		attempt: 7,
		streak: 4,
		notify: true,
	});
	assert.equal((tracker.next("r", err(), policy) as { notify: boolean }).notify, false);
	tracker.reset();
	assert.equal(tracker.next("r", err(), policy).retry, true);
});

test("每条规则各自的次数上限", () => {
	const tracker = new Tracker();
	const two = resolvePolicy({ maxRetries: 2 });
	assert.equal(tracker.next("a", err("x1"), two).retry, true);
	assert.equal(tracker.next("a", err("x2"), two).retry, true);
	assert.equal(tracker.next("b", err("x3"), two).retry, true, "另一条规则有自己的额度");
	assert.deepEqual(tracker.next("a", err("x4"), two), {
		retry: false,
		reason: "budget",
		attempt: 2,
		streak: 1,
		notify: true,
	});
	assert.deepEqual(tracker.progress(), { used: 3, streak: 1 });
});

test("action=stop：命中就停", () => {
	const step = new Tracker().next("quota", err(), resolvePolicy({ action: "stop" }));
	assert.equal(!step.retry && step.reason, "stop");
});
