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

test("只提高 maxRetries 不会放宽默认同错上限：续跑 10 次后仍停", () => {
	const tracker = new Tracker();
	const policy = resolvePolicy({}, { maxRetries: 20 });
	for (let attempt = 1; attempt <= 10; attempt++) assert.equal(tracker.next("auth", err(), policy).retry, true);
	assert.deepEqual(tracker.next("auth", err(), policy), {
		retry: false,
		reason: "same-error",
		attempt: 10,
		streak: 11,
		notify: true,
	});
});

test("同错计数不分规则，但按当前命中规则的上限判断", () => {
	const tracker = new Tracker();
	assert.equal(tracker.next("a", err(), resolvePolicy({ maxSameError: 3 })).retry, true);
	assert.deepEqual(tracker.next("b", err(), resolvePolicy({ maxSameError: 1 })), {
		retry: false,
		reason: "same-error",
		attempt: 0,
		streak: 2,
		notify: true,
	});
});

test("action=stop：命中就停", () => {
	const step = new Tracker().next("quota", err(), resolvePolicy({ action: "stop" }));
	assert.equal(!step.retry && step.reason, "stop");
});
