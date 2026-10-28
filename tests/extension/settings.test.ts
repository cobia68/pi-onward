import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Settings } from "../../src/extension/settings.ts";
import { harness, tempDir, writeConfig } from "../support/fake-pi.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("命令改了就存，重新加载还在", async () => {
	const h = harness();
	assert.match(await h.command("set maxRetries=5"), /最多 5 次/);
	assert.equal(read(h.configPath).maxRetries, 5);
	if (process.platform !== "win32") assert.equal(statSync(h.configPath).mode & 0o777, 0o600);
	const again = harness({ configPath: h.configPath });
	assert.match(await again.command(""), /最多 5 次/);
	await h.command("off");
	assert.equal(read(h.configPath).enabled, false);
	assert.match(await h.command(""), /^onward：关/);
	await h.command("unset maxRetries");
	assert.equal("maxRetries" in read(h.configPath), false);
});

test("保存不动手写的 rules，也不覆盖加载后才手改的内容", async () => {
	const rules = [{ name: "auth", when: { error: "401" } }];
	const h = harness({ config: { rules } });
	writeFileSync(h.configPath, JSON.stringify({ enabled: false, maxRetries: 5, rules, note: "hand-edited" }));
	await h.command("set action=resend");
	assert.deepEqual(read(h.configPath), {
		enabled: false,
		action: "resend",
		maxRetries: 5,
		note: "hand-edited",
		rules,
	});
	assert.match(await h.command(""), /^onward：关/, "重新读到了手改的 enabled");
});

test("一项不合法就都不改", async () => {
	const h = harness({ config: { maxRetries: 5 } });
	assert.match(await h.command("set maxRetries=7 delay=5"), /未做任何修改/);
	assert.deepEqual(read(h.configPath), { maxRetries: 5 });
});

test("reset 去掉开关和参数，保留手写的 rules", async () => {
	const h = harness();
	await h.command("set maxRetries=5");
	assert.match(await h.command("reset"), /最多 10 次.*（已恢复默认）$/);
	assert.deepEqual(read(h.configPath), {});

	const kept = harness({ config: { enabled: false, maxRetries: 3, rules: [{ name: "a" }] } });
	assert.match(await kept.command("reset"), /手写的 rules 保留/);
	assert.deepEqual(read(kept.configPath), { rules: [{ name: "a" }] });
});

test("坏 JSON：不续跑、拒绝写、提示", async () => {
	const path = writeConfig("{ not json");
	const h = harness({ configPath: path });
	await h.emit("session_start", { reason: "startup" });
	assert.match(h.warnings()[0], /读不了/);
	assert.match(await h.command("set maxRetries=5"), /不是合法 JSON.*先修好；未做任何修改$/);
	assert.doesNotMatch(await h.command(""), /最多 5 次/, "没有改");
	assert.match(await h.command("reset"), /未做任何修改$/);
	assert.equal(readFileSync(path, "utf8"), "{ not json", "原文件没被覆盖");
	assert.equal(new Settings(path).reset().kind, "broken");
});

test("show：每个参数的值和来源，再是规则", async () => {
	const h = harness({
		config: { action: "resend", delay: "5s,10s", rules: [{ name: "auth", when: { error: "401" } }] },
	});
	const text = await h.command("show");
	assert.match(text, /action\s+resend（设置文件）/);
	assert.match(text, /prompt\s+「继续」（内置默认值）/);
	assert.match(text, /delay\s+5s,10s（设置文件）/);
	assert.match(text, /1\. auth：错误匹配 \/401\/i → 静默重发同一请求/);
	assert.match(await h.command("show rules"), /^按顺序第一条命中的生效/);
});

test("保存时会建目录", () => {
	const path = join(tempDir(), "nested", "onward.json");
	new Settings(path).update({ set: { maxRetries: 3 } });
	assert.deepEqual(read(path), { maxRetries: 3 });
});
