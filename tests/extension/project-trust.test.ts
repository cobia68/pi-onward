import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { err, harness, projectConfigPath, rule, stage, tempDir, writeConfig } from "../support/fake-pi.ts";

const global = { rules: [rule([stage()], "global")] };
const project = { rules: [rule([stage(1, "pi.command", { name: "marker" })], "project")] };
const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });

test("未受信任的项目不能通过配置调用扩展命令，全局规则仍然生效", async () => {
	const h = harness({ config: global, project, trusted: false });
	let calls = 0;
	h.pi.registerCommand("marker", {
		handler: async () => {
			calls++;
		},
	});
	await start(h);
	assert.equal((await h.boundary(err()))?.continue, true);
	assert.equal(calls, 0);
	assert.match(await h.command("status"), /命中规则\s+global/);
	assert.match(await h.command("show"), /未受信任/);
	const layer = await h.command("--scope project show");
	assert.match(layer, /未受信任[\s\S]*未读取/);
	assert.doesNotMatch(layer, /pi\.command|marker/);
});

test("未受信任的项目文件不解析、不写入，坏 JSON 不阻断全局配置", async () => {
	const h = harness({ config: global, project: "{ invalid", trusted: false });
	await start(h);
	assert.equal((await h.boundary(err()))?.continue, true);
	for (const action of ["on", "off", "set maxFailures=3", "unset maxFailures", "reset"])
		assert.match(await h.command(`--scope project ${action}`), /未受信任[\s\S]*未修改/);
	assert.equal(readFileSync(h.projectPath, "utf8"), "{ invalid");
	assert.doesNotMatch(await h.command("show"), /配置无效/);
});

test("查询保持加载快照，重载重新判断项目的信任状态", async () => {
	const h = harness({ config: global, project, trusted: false });
	await start(h);
	h.trusted = true;
	assert.doesNotMatch(await h.command("show rules"), /pi\.command/);
	await h.command("reload");
	assert.match(await h.command("show rules"), /pi\.command/);
	h.trusted = false;
	await h.command("reload");
	assert.doesNotMatch(await h.command("show rules"), /pi\.command/);
	assert.equal((await h.boundary(err()))?.continue, true);
});

test("切换会话目录后不继承旧目录的信任或项目规则", async () => {
	const h = harness({ config: global, project, trusted: true });
	await start(h);
	assert.match(await h.command("show rules"), /pi\.command/);
	h.ctx.cwd = tempDir();
	writeConfig(project, projectConfigPath(h.ctx.cwd));
	h.trusted = false;
	await h.emit("session_start", { reason: "resume" });
	assert.match(await h.command("show"), /未受信任/);
	assert.equal((await h.boundary(err()))?.continue, true);
	assert.match(await h.command("status"), /命中规则\s+global/);
});
