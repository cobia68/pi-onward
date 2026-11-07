import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Settings } from "../../src/extension/settings.ts";
import { err, harness, paths, rule, stage, tempDir, writeConfig } from "../support/fake-pi.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });

test("配置修改持久保存；项目层逐字段覆盖，规则整份替换", async () => {
	const h = harness({
		config: { maxFailures: 8, rules: [rule()] },
		project: { maxFailures: 3, rules: [rule([stage(1, "onward.stop")], "project")] },
	});
	await start(h);
	const projectBefore = readFileSync(h.projectPath, "utf8");
	assert.match(await h.command("set maxFailures=7 actionTimeout=2s"), /maxFailures\s+7[\s\S]*项目级配置覆盖/);
	assert.equal(read(h.configPath).maxFailures, 7);
	assert.equal(readFileSync(h.projectPath, "utf8"), projectBefore);
	assert.match(await h.command("show"), /maxFailures\s+3（项目级配置）/);
	assert.match(await h.command("show rules"), /项目级 rules 整份替换全局/);
	assert.match(await h.command("--scope project unset maxFailures"), /maxFailures\s+7（全局配置）/);
	await h.boundary(err());
	assert.match(await h.command("status"), /命中规则\s+project/);
});

test("先重读再保存，不覆盖用户随后手写的规则和未知内容", async () => {
	const h = harness();
	await start(h);
	const updated = [rule([stage(), stage(3, "onward.stop")])];
	writeConfig({ rules: updated, note: "keep" }, h.configPath);
	await h.command("set maxFailures=3");
	assert.deepEqual(read(h.configPath), { maxFailures: 3, note: "keep", rules: updated });
	assert.match(await h.command("status"), /配置无效/);
});

test("set 任一参数不合法都不写入、不取消当前等待；帮助与查询也没有副作用", async () => {
	const h = harness({ config: { rules: [rule([stage(1, "pi.message", undefined, "5s")])] } });
	await start(h);
	const before = readFileSync(h.configPath, "utf8");
	const waiting = h.boundary(err());
	await new Promise<void>((resolve) => setImmediate(resolve));
	for (const command of ["set maxFailures=7 actionTimeout=x", "set maxRetries=3"])
		assert.match(await h.command(command), /No changes made/);
	for (const command of ["show", "show rules", "--scope project show", "status", "set --help", "actions"])
		await h.command(command);
	assert.match(h.status()!, /等待/);
	assert.equal(readFileSync(h.configPath, "utf8"), before);
	await h.command("off");
	await waiting;
	assert.equal(h.status(), undefined);
	assert.deepEqual(h.sent, []);
});

test("配置保存失败明确区分内存与磁盘，不能伪报成功", async () => {
	const h = harness();
	await start(h);
	// Force atomic rename to fail by making the temporary file path a directory.
	const temp = `${h.configPath}.${process.pid}.tmp`;
	mkdirSync(temp);
	try {
		assert.match(await h.command("set maxFailures=6"), /保存失败[\s\S]*本次运行保留了配置修改/);
		assert.match(await h.command("show"), /maxFailures\s+6（全局配置，未保存）/);
		assert.equal(read(h.configPath).maxFailures, undefined);
		await h.command("reload");
		const reloaded = await h.command("show");
		assert.match(reloaded, /maxFailures\s+20（内置默认值）/);
		assert.doesNotMatch(reloaded, /未保存/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("另一层修改不会丢掉尚未保存的 off，也不会重新启用恢复", async () => {
	const h = harness();
	await start(h);
	const temp = `${h.configPath}.${process.pid}.tmp`;
	mkdirSync(temp);
	try {
		assert.match(await h.command("off"), /保存失败/);
		await h.command("--scope project set maxFailures=7");
		assert.equal(await h.boundary(err()), undefined);
		assert.match(await h.command("status"), /自动恢复\s+已停用/);
		assert.match(await h.command("show"), /enabled\s+false（全局配置，未保存）/);
		assert.equal(read(h.configPath).enabled, undefined);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("同层未保存的 set 和 unset 合并，下次成功保存时一并落盘且保留手改规则", async () => {
	const h = harness({ config: { maxHandoffs: 2, rules: [rule()] } });
	await start(h);
	const temp = `${h.configPath}.${process.pid}.tmp`;
	mkdirSync(temp);
	try {
		await h.command("set maxFailures=6");
		await h.command("unset maxHandoffs");
		assert.match(await h.command("show"), /maxFailures\s+6（全局配置，未保存）/);
		assert.match(await h.command("show"), /maxHandoffs\s+3（内置默认值）/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	const rules = [rule([stage(), stage(3, "onward.stop")])];
	writeConfig({ maxHandoffs: 2, rules }, h.configPath);
	await h.command("set actionTimeout=2s");
	assert.deepEqual(read(h.configPath), { maxFailures: 6, actionTimeout: "2s", rules });
	assert.doesNotMatch(await h.command("show"), /未保存/);
});

test("未保存的项目 unset 持续继承最新全局值，不被另一层保存覆盖", async () => {
	const h = harness({ config: { maxFailures: 8, rules: [rule()] }, project: { maxFailures: 3 } });
	await start(h);
	const temp = `${h.projectPath}.${process.pid}.tmp`;
	mkdirSync(temp);
	try {
		await h.command("--scope project unset maxFailures");
		await h.command("set maxFailures=9");
		assert.match(await h.command("show"), /maxFailures\s+9（全局配置）/);
		assert.match(await h.command("--scope project show"), /未保存/);
		assert.equal(read(h.projectPath).maxFailures, 3);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	await h.command("--scope project set maxHandoffs=1");
	assert.deepEqual(read(h.projectPath), { maxHandoffs: 1 });
});

test("无法读取的文件拒绝写回，reset 仍取消恢复状态", async () => {
	const h = harness();
	await start(h);
	await h.boundary(err());
	writeConfig("{ invalid", h.configPath);
	assert.match(await h.command("set maxFailures=5"), /配置文件无法读取，配置未修改/);
	assert.match(await h.command("reset"), /配置未修改[\s\S]*本轮恢复状态和计数已重置/);
	assert.equal(h.status(), undefined);
	assert.equal(readFileSync(h.configPath, "utf8"), "{ invalid");
});

test("reset 保留规则，空项目配置不误建；项目层尚未绑定时不写", async () => {
	const h = harness({ config: { maxFailures: 5, enabled: false, rules: [rule()] } });
	assert.match(await h.command("--scope project on"), /当前目录尚未确定/);
	await start(h);
	await h.command("reset");
	assert.deepEqual(read(h.configPath), { rules: [rule()] });
	await h.command("--scope project reset");
	await h.command("--scope project unset maxFailures");
	assert.equal(existsSync(h.projectPath), false);
});

test("show 使用加载时快照，单层查询不被另一层错误阻断", async () => {
	const h = harness({ config: { maxFailures: 5, rules: [rule()] }, project: { maxFailures: 0 } });
	await start(h);
	assert.match(await h.command("show"), /配置无效/);
	assert.match(await h.command("--scope global show"), /仅本层配置[\s\S]*maxFailures\s+5/);
	writeConfig({ maxFailures: 9 }, h.configPath);
	assert.match(await h.command("--scope global show"), /maxFailures\s+5/);
});

test("on/off 简洁报告目标范围，项目覆盖准确，quietStartup 跟随 Pi", async () => {
	const h = harness({ project: { enabled: true } });
	await start(h);
	assert.match(await h.command("off"), /已停用自动恢复（全局配置）[\s\S]*当前项目仍启用/);
	assert.equal(await h.command("--scope project off"), "onward：已停用自动恢复（项目级配置）");
	for (const quietStartup of [true, "header"]) {
		const quiet = harness({ config: {}, piSettings: { quietStartup } });
		await start(quiet);
		assert.deepEqual(quiet.notes, []);
	}
	const invalid = harness({ config: { quietStartup: true, maxFailures: 0 } });
	await start(invalid);
	assert.equal(invalid.warnings().length, 1);
});

test("非法 JSON 的底层报错使用英文并保留解析器原因", () => {
	const file = writeConfig("{ invalid");
	const settings = new Settings(paths(file));
	assert.match(settings.config.problems[0]!, /^Invalid JSON: /);
	const saved = settings.update("global", { enabled: true });
	assert.ok(saved.kind === "broken");
	assert.match(saved.error, /^Invalid JSON: /);
	assert.doesNotMatch(saved.error, /\p{Script=Han}/u);
	assert.equal(readFileSync(file, "utf8"), "{ invalid");
});

test("设置文件读写模块拒绝非对象 JSON，嵌套目录可自动创建", () => {
	for (const raw of ["[]", "null", '"x"']) {
		const file = writeConfig(raw);
		const settings = new Settings(paths(file));
		assert.deepEqual(settings.update("global", { enabled: true }), {
			kind: "broken",
			path: file,
			error: "Top-level configuration must be a JSON object",
		});
		assert.deepEqual(settings.config.problems, ["Top-level configuration must be a JSON object"]);
		assert.equal(readFileSync(file, "utf8"), raw);
	}
	const file = join(tempDir(), "nested", "onward.json");
	assert.equal(new Settings(paths(file)).update("global", { set: { maxFailures: 3 } }).kind, "saved");
	assert.deepEqual(read(file), { maxFailures: 3 });
});
