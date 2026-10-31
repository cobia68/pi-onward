// 项目级设置：当前目录的 .pi/onward.json，有就读，不看 pi 对项目的信任；和全局合并，项目级在后。
// 假的 ctx 里没有 isProjectTrusted：哪天又去问信任，这里的测试会先失败。
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { err, harness, projectConfigPath, tempDir, writeConfig } from "../support/fake-pi.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });

test("顶层字段逐个覆盖全局；项目级写了 rules 就整份替换，不拼接", async () => {
	const h = harness({
		config: { delay: "0s", maxRetries: 5, rules: [{ name: "any" }] },
		project: { maxRetries: 2, rules: [{ name: "auth", when: { error: "401" } }] },
	});
	await start(h);
	assert.equal((await h.boundary(err("401 Invalid API key")))?.continue, true);
	assert.equal(h.status(), "⏩ 续跑 1/2 · auth", "maxRetries 用项目级的，delay 用全局的");
	await h.emit("agent_start");
	assert.equal(await h.boundary(err("502 Bad Gateway")), undefined, "全局的兜底不在了");
});

test("项目级没写 rules：用全局的；写了空的 rules：这个项目里没有规则", async () => {
	const params = harness({
		config: { delay: "0s", rules: [{ name: "any" }] },
		project: { maxRetries: 1 },
	});
	await start(params);
	await params.boundary(err("502 Bad Gateway"));
	assert.equal(params.status(), "⏩ 续跑 1/1 · any");

	const none = harness({ config: { delay: "0s", rules: [{ name: "any" }] }, project: { rules: [] } });
	await start(none);
	assert.equal(await none.boundary(err()), undefined);
	assert.match(await none.command("status"), /^💤 onward：开，但没有可用的规则/);
});

test("不写 --scope 只改全局，项目级不动", async () => {
	const h = harness({ config: { rules: [{ name: "any" }] }, project: { maxRetries: 2 } });
	await start(h);
	const before = readFileSync(h.projectPath, "utf8");
	await h.command("set delay=5s");
	assert.equal(read(h.configPath).delay, "5s");
	assert.equal(readFileSync(h.projectPath, "utf8"), before);
});

test("任何一份读不懂，整份不生效：不会只按另一份续跑", async () => {
	const broken = harness({ config: { delay: "0s", rules: [{ name: "any" }] }, project: "{ not json" });
	await start(broken);
	assert.match(broken.warnings()[0], /onward\.json 读不了：不是合法 JSON/);
	assert.ok(broken.warnings()[0]!.includes(broken.projectPath));
	assert.equal(await broken.boundary(err()), undefined);
	assert.match(await broken.command("status"), /^🛑 onward：设置文件读不了/);
	assert.match(await broken.command("show rules"), /^设置文件读不了[\s\S]*项目级 {2}.*\n {10}读不了：不是合法 JSON/);
	assert.match(await broken.command("--scope project set maxRetries=3"), /读不了（不是合法 JSON.*未做任何修改$/);
	assert.equal(readFileSync(broken.projectPath, "utf8"), "{ not json", "原文件没被覆盖");

	const bad = harness({ config: { delay: "0s", rules: [{ name: "any" }] }, project: { colour: "red" } });
	await start(bad);
	assert.deepEqual(bad.notes, [
		["info", `onward：用上了项目级设置 ${bad.projectPath}，它写了的字段覆盖全局的`],
		["warning", `🛑 onward：${bad.projectPath} 有 1 处问题，修好之前不会自动续跑（/onward show 查看）`],
	]);
	assert.equal(await bad.boundary(err()), undefined);
	assert.match(await bad.command("show rules"), /^- 项目级：colour 不认识$/m, "问题前面标上是哪一份的");

	const user = harness({ config: { maxRetries: 99 }, project: { rules: [{ name: "any" }] } });
	await start(user);
	assert.deepEqual(user.warnings(), [
		`🛑 onward：${user.configPath} 有 1 处问题，修好之前不会自动续跑（/onward show 查看）`,
	]);
	assert.match(await user.command("show rules"), /^- 全局：maxRetries 需要 1–50 的整数$/m);
});

test("没有项目级文件时，--scope project 的 reset、unset 不建空文件", async () => {
	const h = harness({ config: { rules: [{ name: "any" }] } });
	await start(h);
	assert.match(await h.command("--scope project reset"), /^⏩ onward：开，1 条规则生效/);
	assert.match(await h.command("--scope project unset delay"), /^⏩ onward：开，1 条规则生效/);
	assert.equal(existsSync(h.projectPath), false);
	assert.ok((await h.command("status")).includes(`${h.projectPath}（还没有`));
	await start(h);
	assert.doesNotMatch(h.notes.map(([, m]) => m).join("\n"), /用上了项目级设置/, "以后启动也不提醒");

	// 文件在时照常写回，哪怕只剩 {}。
	await h.command("--scope project set maxRetries=3");
	await h.command("--scope project unset maxRetries");
	assert.deepEqual(read(h.projectPath), {});
});

test("--scope project：改项目级，没有就建，全局不动", async () => {
	const h = harness({ config: { rules: [{ name: "any" }] } });
	await start(h);
	assert.equal(existsSync(h.projectPath), false);
	const text = await h.command("--scope project set maxRetries=3");
	assert.match(text, /^⏩ onward：开，1 条规则生效\n改的是项目级设置\n/);
	assert.match(text, /最多 3 次/);
	assert.deepEqual(read(h.projectPath), { maxRetries: 3 });
	assert.deepEqual(read(h.configPath), { rules: [{ name: "any" }] });
	await h.command("--scope project off");
	assert.deepEqual(read(h.projectPath), { enabled: false, maxRetries: 3 });
	assert.match(await h.command("status"), /^💤 onward：关[\s\S]*\/onward --scope project on 打开$/);
	await h.command("--scope project unset maxRetries");
	assert.deepEqual(read(h.projectPath), { enabled: false });
});

test("改全局时，项目级写了同名的：说这个项目里仍按项目级的走", async () => {
	const h = harness({ config: { rules: [{ name: "any" }] }, project: { enabled: false, maxRetries: 2 } });
	await start(h);
	const on = await h.command("on");
	assert.match(
		on,
		/^💤 onward：关，出错时不会自动续跑\n改的是全局设置\n项目级设置也写了 enabled，这个项目里仍按项目级的走；要跟随全局时运行 \/onward --scope project unset enabled\n/,
	);
	assert.equal(read(h.configPath).enabled, true, "全局照样写了");
	assert.match(
		await h.command("set maxRetries=7 delay=5s"),
		/项目级设置也写了 maxRetries，.*运行 \/onward --scope project unset maxRetries$/m,
	);
	assert.match(
		await h.command("reset"),
		/项目级设置也写了 enabled、maxRetries，.*unset enabled maxRetries$/m,
		"一条命令去掉全部",
	);
	assert.doesNotMatch(await h.command("set delay=6s"), /项目级设置也写了/);
	assert.match(await h.command("--scope project on"), /^⏩ onward：开，1 条规则生效\n改的是项目级设置$/m);
});

test("unset enabled：去掉项目级的开关，这个项目改按全局的走；参数留着", async () => {
	const h = harness({
		config: { enabled: false, rules: [{ name: "any" }] },
		project: { enabled: true, maxRetries: 2 },
	});
	await start(h);
	assert.match(await h.command("status"), /^⏩ onward：开/);
	assert.match(await h.command("--scope project unset enabled"), /^💤 onward：关/);
	assert.deepEqual(read(h.projectPath), { maxRetries: 2 });
	assert.match(await h.command("show"), /maxRetries {4}2（项目级设置）/);
	assert.match(await h.command("unset enabled"), /^⏩ onward：开/, "全局也去掉：退回内置的开");
	assert.deepEqual(read(h.configPath), { rules: [{ name: "any" }] });
});

test("reset：去掉那一份的开关和参数，另一份照常生效；手写的 rules 留着", async () => {
	const h = harness({
		config: { maxRetries: 5, rules: [{ name: "any" }] },
		project: { enabled: false, maxRetries: 2, rules: [{ name: "auth", when: { error: "401" } }] },
	});
	await start(h);
	const project = await h.command("--scope project reset");
	assert.match(project, /^⏩ onward：开，1 条规则生效\n已去掉项目级的开关和参数，手写的 rules 保留\n/);
	assert.match(project, /最多 5 次/, "退回全局的");
	assert.deepEqual(read(h.projectPath), { rules: [{ name: "auth", when: { error: "401" } }] });

	await h.command("--scope project set maxRetries=2");
	const user = await h.command("reset");
	assert.match(user, /\n已去掉全局的开关和参数，手写的 rules 保留\n项目级设置也写了 maxRetries，/);
	assert.deepEqual(read(h.configPath), { rules: [{ name: "any" }] });
});

test("show：每个参数来自哪一份；规则来自哪一份", async () => {
	const h = harness({
		config: { action: "resend", maxRetries: 5, rules: [{ name: "any" }] },
		project: { maxRetries: 2, rules: [{ name: "auth", when: { error: "401" } }] },
	});
	await start(h);
	const text = await h.command("show");
	assert.match(text, /^ {2}action {8}resend（全局设置）$/m);
	assert.match(text, /^ {2}maxRetries {4}2（项目级设置）$/m);
	assert.match(text, /^ {2}delay {9}3s\.\.15s（内置默认值）$/m);
	assert.match(text, /^规则来自项目级设置，全局的 rules 不生效\n规则（按顺序/m);
	assert.match(text, /^ {2}全局 {2}.*onward\.json$/m);
	assert.match(text, /^ {2}项目级 {2}.*\.pi[/\\]onward\.json$/m);

	const userRules = harness({ config: { rules: [{ name: "any" }] }, project: { maxRetries: 2 } });
	await start(userRules);
	assert.match(await userRules.command("show rules"), /^规则来自全局设置\n规则（按顺序/);

	const single = harness({ config: { rules: [{ name: "any" }] } });
	await start(single);
	assert.match(await single.command("show rules"), /^规则（按顺序/, "只有一份时不说来自哪");
});

test("启动时：用上了项目级设置要说一句；没有可用的规则时指到规则所在的那份", async () => {
	const h = harness({ config: { rules: [{ name: "any" }] }, project: { maxRetries: 2 } });
	await start(h);
	assert.deepEqual(h.notes, [["info", `onward：用上了项目级设置 ${h.projectPath}，它写了的字段覆盖全局的`]]);

	const none = harness({ config: { rules: [{ name: "any" }] } });
	await start(none);
	assert.deepEqual(none.notes, [], "没有项目级设置：什么都不说");

	const empty = harness({ config: { rules: [{ name: "any" }] }, project: { rules: [] } });
	await start(empty);
	assert.match(empty.notes.at(-1)![1], /^💤 onward：没有可用的规则/);
	assert.ok(empty.notes.at(-1)![1].includes(` ${empty.projectPath} `), "rules 写在项目级");
});

test("reload 两份都重读", async () => {
	const h = harness({ config: { delay: "0s", rules: [{ name: "any" }] } });
	await start(h);
	writeConfig({ rules: [{ name: "auth", when: { error: "401" } }] }, h.projectPath);
	writeFileSync(h.configPath, JSON.stringify({ delay: "0s", maxRetries: 4, rules: [{ name: "any" }] }));
	assert.match(await h.command("reload"), /最多 4 次/);
	assert.equal(await h.boundary(err("502 Bad Gateway")), undefined, "项目级的 rules 替换了全局的");
	assert.equal((await h.boundary(err("401 Invalid API key")))?.continue, true);
	assert.equal(h.status(), "⏩ 续跑 1/4 · auth");
});

test("只看当前目录的 .pi/onward.json，不往上级目录找", async () => {
	const parent = tempDir();
	writeConfig({ rules: [] }, projectConfigPath(parent));
	const h = harness({ config: { rules: [{ name: "any" }] }, cwd: join(parent, "packages", "app") });
	await start(h);
	assert.deepEqual(h.notes, []);
	assert.match(await h.command("status"), /^⏩ onward：开，1 条规则生效/);
	assert.ok(
		(await h.command("status")).includes(`${projectConfigPath(join(parent, "packages", "app"))}（还没有`),
		"状态里列的是当前目录的",
	);
});

test("session_start 之前只有全局：项目级还不知道在哪，--scope project 不写", async () => {
	const h = harness({ config: { rules: [{ name: "any" }] }, project: { rules: [] } });
	const status = await h.command("status");
	assert.match(status, /^⏩ onward：开，1 条规则生效/);
	assert.doesNotMatch(status, /项目级/);
	assert.match(
		await h.command("--scope project set maxRetries=3"),
		/^onward：还不知道当前目录，改不了项目级设置.*未做任何修改$/,
	);
	assert.equal(existsSync(h.projectPath), true, "项目级文件还是原样");
	assert.deepEqual(read(h.projectPath), { rules: [] });
});

test("--scope <层> show：只看这一份写了什么，不合并、不填默认值", async () => {
	const h = harness({
		config: {
			maxRetries: 5,
			rules: [
				{ name: "any", delay: "1s" },
				{ name: "auth", enabled: false, when: { error: "401" } },
			],
		},
		project: { enabled: false, maxRetries: 2 },
	});
	await start(h);
	const global = await h.command("--scope global show");
	assert.match(global, /^全局设置 \S+onward\.json\n {2}maxRetries {2}5\n/);
	assert.match(global, /^ {2}1\. any：任何错误；delay=1s$/m, "规则照写的列，只列它自己写了的参数");
	assert.match(global, /^ {2}2\. auth（已停用）：错误匹配 \/401\/i$/m);
	assert.match(global, /合并后实际用的见 \/onward show$/);
	assert.doesNotMatch(global, /enabled|prompt|delay {2}/, "没写的不列，也不填默认值");
	const project = await h.command("--scope project show");
	assert.match(project, /^项目级设置 \S+\.pi\/onward\.json\n {2}enabled {5}false\n {2}maxRetries {2}2\n/);
	assert.match(project, /^没写 rules，用全局设置的$/m);
	assert.equal((await h.command("--scope project show rules")).includes("maxRetries"), false, "rules 只看规则");

	const bad = harness({ config: { rules: [] }, project: { colour: "red" } });
	await start(bad);
	assert.match(await bad.command("--scope project show"), /\n有 1 处问题，修好之前不会自动续跑：\n- colour 不认识$/);
	assert.match(await bad.command("--scope global show"), /^rules 是空的：没有规则$/m);
	const missing = harness({ config: {} });
	await start(missing);
	assert.match(await missing.command("--scope project show"), /（还没有，改设置时写 --scope project 自动建）$/);
	assert.match(
		await harness({ config: {} }).command("--scope project show"),
		/^onward：还不知道当前目录，看不了项目级设置；会话开始之后再看$/,
	);
});
