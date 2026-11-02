// quietStartup：启动时的提示跟着 pi 的 quietStartup，onward 自己的写了就按它；设置有问题照样警告。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { completeArguments, helpText, parseCommand } from "../../src/extension/command.ts";
import { harness } from "../support/fake-pi.ts";

const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const values = (prefix: string) => completeArguments(prefix)?.map((item) => item.value);
const IDLE = "💤 onward：没有可用的规则，出错时不会自动续跑（/onward show 查看）";

test("pi 的 quietStartup 是 true 或 header 时，启动不说平常的；设置有问题照样警告", async () => {
	for (const quietStartup of [true, "header"]) {
		const h = harness({ piSettings: { quietStartup } });
		await start(h);
		assert.deepEqual(h.notes, [], String(quietStartup));
		const project = harness({
			config: { rules: [{ name: "any", action: "message" }] },
			project: { maxRetries: 2 },
			piSettings: { quietStartup },
		});
		await start(project);
		assert.deepEqual(project.notes, [], "用上了项目级设置也不说");
		const bad = harness({ config: { maxRetries: 0 }, piSettings: { quietStartup } });
		await start(bad);
		assert.deepEqual(bad.warnings(), ["🛑 onward：全局设置有 1 处问题，修好之前不会自动续跑（/onward show 查看）"]);
	}
	for (const piSettings of [{}, { quietStartup: false }]) {
		const h = harness({ piSettings });
		await start(h);
		assert.deepEqual(h.notes, [["info", IDLE]], JSON.stringify(piSettings));
	}
});

test("onward 自己的 quietStartup 写了就按它，不管 pi 的", async () => {
	const quiet = harness({ config: { quietStartup: true }, piSettings: { quietStartup: false } });
	await start(quiet);
	assert.deepEqual(quiet.notes, []);
	const shown = harness({ config: { quietStartup: false }, piSettings: { quietStartup: true } });
	await start(shown);
	assert.deepEqual(shown.notes, [["info", IDLE]]);
});

test("项目级设置不能写 quietStartup：别人的仓库关不掉「用上了项目级设置」这句提醒", async () => {
	const h = harness({ config: { rules: [{ name: "any", action: "message" }] }, project: { quietStartup: true } });
	await start(h);
	assert.deepEqual(h.warnings(), ["🛑 onward：项目级设置有 1 处问题，修好之前不会自动续跑（/onward show 查看）"]);
	assert.match(await h.command("--scope project show"), /^- quietStartup 只能写在全局设置$/m);
	assert.match(
		await h.command("--scope project set quietStartup=false"),
		/^onward：quietStartup 只能写在全局设置，不写 --scope 就是全局。未做任何修改；用法见 \/onward set --help$/,
	);
	assert.match(
		await h.command("--scope project unset quietStartup"),
		/^⏩ onward：开，1 条规则生效\n改的是项目级设置\n/,
	);
	assert.deepEqual(read(h.projectPath), {}, "去掉就好了");
});

test("set、unset quietStartup：只改全局，回复说启动提示现在怎么显示；reset 也去掉它", async () => {
	const h = harness({ config: { rules: [{ name: "any", action: "message" }] } });
	await start(h);
	assert.match(
		await h.command("set quietStartup=true"),
		/^⏩ onward：开，1 条规则生效\nonward 的启动提示不显示；设置有问题时照样警告\n/,
	);
	assert.deepEqual(read(h.configPath), { quietStartup: true, rules: [{ name: "any", action: "message" }] });
	assert.match(await h.command("--scope global show"), /^全局设置 \S+\n {2}quietStartup {2}true\n/);
	assert.match(await h.command("set quietStartup=false"), /\nonward 的启动提示照常显示，不管 pi 的 quietStartup\n/);
	assert.match(await h.command("set quietStartup=yes"), /^onward：quietStartup 需要 true 或 false。未做任何修改/);
	assert.match(await h.command("unset quietStartup"), /\nonward 的启动提示跟着 pi 的 quietStartup\n/);
	assert.deepEqual(read(h.configPath), { rules: [{ name: "any", action: "message" }] });
	await h.command("set quietStartup=true maxRetries=3");
	assert.match(await h.command("reset"), /^⏩ onward：开，1 条规则生效\n已恢复默认，手写的 rules 保留\n/);
	assert.deepEqual(read(h.configPath), { rules: [{ name: "any", action: "message" }] });
	assert.deepEqual(parseCommand("set quietStartup=true"), {
		kind: "update",
		scope: "global",
		change: { set: { quietStartup: true } },
	});
	assert.equal(parseCommand("set quietStartup=true quietStartup=false").kind, "error", "写了两次");
});

test("补全和帮助：quietStartup 只在全局给；帮助的字段表里有它", () => {
	assert.deepEqual(values("set q"), ["set quietStartup="]);
	assert.deepEqual(values("set quietStartup="), ["set quietStartup=true ", "set quietStartup=false "]);
	assert.deepEqual(values("unset q"), ["unset quietStartup "]);
	assert.deepEqual(values("--scope global set q"), ["--scope global set quietStartup="]);
	assert.equal(completeArguments("--scope project set q"), null, "项目级不能写");
	assert.equal(completeArguments("--scope project set quietStartup=true "), null, "执行时会被拒绝");
	assert.equal(completeArguments("set quietStartup=true q"), null, "写过了");
	for (const action of ["set", "unset"])
		assert.match(helpText(action), /^ {2}quietStartup {2}启动时的提示（用上了项目级设置、没有可用的规则）/m, action);
	assert.match(helpText("set"), /^ {16}不写：跟着 pi 的 quietStartup（默认）$/m);
});
