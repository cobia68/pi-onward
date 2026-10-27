import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Settings } from "../../src/extension/settings.ts";
import { harness, tempDir, writeConfig } from "../support/fake-pi.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("命令改了就存，重新加载还在", async () => {
	const h = harness();
	assert.match(await h.command("5"), /最多 5 次/);
	assert.equal(read(h.configPath).defaults.maxRetries, 5);
	if (process.platform !== "win32") assert.equal(statSync(h.configPath).mode & 0o777, 0o600);
	const again = harness({ configPath: h.configPath });
	assert.match(await again.command(""), /最多 5 次/);
	await h.command("off");
	assert.equal(read(h.configPath).enabled, false);
	assert.match(await h.command(""), /^onward：关/);
});

test("保存不动手写的 rules，也不覆盖加载后才手改的内容", async () => {
	const rules = [{ name: "auth", when: { match: "401" } }];
	const h = harness({ config: { rules } });
	writeFileSync(h.configPath, JSON.stringify({ rules, note: "hand-edited" }));
	await h.command("silent");
	const saved = read(h.configPath);
	assert.deepEqual(saved.rules, rules);
	assert.equal(saved.note, "hand-edited");
	assert.equal(saved.defaults.mode, "silent");
});

test("命令只合并这次改到的字段：加载后手改的 enabled 和 defaults 不被盖掉", async () => {
	const h = harness({ config: { defaults: { maxRetries: 5 } } });
	writeFileSync(h.configPath, JSON.stringify({ enabled: false, defaults: { maxRetries: 5, prompt: "手改的" } }));
	await h.command("silent");
	assert.deepEqual(read(h.configPath), {
		enabled: false,
		defaults: { maxRetries: 5, prompt: "手改的", mode: "silent" },
	});
	assert.match(await h.command(""), /^onward：关/, "重新读到了手改的 enabled");
});

test("reset 只去掉 enabled/defaults；没有别的内容就删文件", async () => {
	const h = harness();
	await h.command("5");
	assert.match(await h.command("reset"), /最多 10 次.*（已恢复默认）$/);
	assert.equal(existsSync(h.configPath), false);

	const kept = harness({ config: { enabled: false, defaults: { maxRetries: 3 }, rules: [{ name: "a" }] } });
	assert.match(await kept.command("reset"), /手写的 rules 保留/);
	assert.deepEqual(read(kept.configPath), { rules: [{ name: "a" }] });
});

test("坏 JSON：不续跑、拒绝写、提示", async () => {
	const path = writeConfig("{ not json");
	const h = harness({ configPath: path });
	await h.emit("session_start", { reason: "startup" });
	assert.match(h.warnings()[0], /读不了/);
	assert.match(await h.command("5"), /不是合法 JSON[\s\S]*最多 5 次/, "存不下，本次运行仍然生效");
	assert.equal(readFileSync(path, "utf8"), "{ not json", "原文件没被覆盖");
	assert.throws(() => new Settings(path).reset(), /不是合法 JSON/);
});

test("旧版 auto-continue.json：没有新文件时读它，第一次保存写到新文件", async () => {
	const dir = tempDir();
	const legacyPath = join(dir, "auto-continue.json");
	const configPath = join(dir, "onward.json");
	writeFileSync(legacyPath, JSON.stringify({ maxRetries: 50, mode: "silent" }));
	assert.equal(new Settings(configPath, legacyPath).source.kind, "legacy");
	const h = harness({ configPath, legacyPath });
	assert.match(await h.command(""), /静默重发同一请求，最多 50 次.*读的是旧设置文件/);
	await h.command("same=5");
	assert.deepEqual(read(configPath), {
		enabled: true,
		defaults: { maxRetries: 50, mode: "silent", sameErrorLimit: 5 },
	});
	assert.equal(new Settings(configPath, legacyPath).source.kind, "file");
	assert.equal(existsSync(legacyPath), true, "旧文件不删，由用户决定");
});

test("保存时会建目录", () => {
	const path = join(tempDir(), "nested", "onward.json");
	new Settings(path).update({ patch: {} });
	assert.deepEqual(read(path), { enabled: true, defaults: {} });
});
