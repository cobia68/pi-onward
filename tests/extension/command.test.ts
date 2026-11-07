import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { CombinedAutocompleteProvider, Editor, type TUI } from "@earendil-works/pi-tui";
import { argumentTabCompletion } from "../../src/extension/autocomplete.ts";
import { completeArguments, helpText, menuItems, parseCommand } from "../../src/extension/command.ts";
import { renderContinue } from "../../src/extension/render.ts";
import { boundaryEvent, err, harness, rule, stage, tempDir } from "../support/fake-pi.ts";

const cwd = tempDir();
after(() => rmSync(cwd, { recursive: true, force: true }));
async function tab(text: string): Promise<string> {
	const id = (s: string) => s;
	const editor = new Editor({ requestRender() {}, terminal: { rows: 40 } } as unknown as TUI, {
		borderColor: id,
		selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
	});
	editor.setAutocompleteProvider(
		argumentTabCompletion(
			new CombinedAutocompleteProvider([{ name: "onward", getArgumentCompletions: completeArguments }], cwd),
		),
	);
	editor.setText(text);
	editor.handleInput("\t");
	await tick();
	return editor.getText();
}

test("命令严格解析作用域、字段与参数，所有帮助示例可解析", () => {
	assert.deepEqual(parseCommand("--scope project set maxFailures=3 maxHandoffs=0"), {
		kind: "update",
		scope: "project",
		change: { set: { maxFailures: 3, maxHandoffs: 0 } },
	});
	assert.deepEqual(parseCommand("actions"), { kind: "actions" });
	assert.deepEqual(parseCommand("set maxFailures=0 --help"), { kind: "help", topic: "set" });
	for (const command of [
		"set maxRetries=3",
		"set action=resend",
		"set actionTimeout=0s",
		"set maxFailures=2 --scope project",
		"--scope project actions",
		"set maxFailures=3 maxFailures=4",
		"set maxHandoffs=",
		"set",
		"set enabled=true",
		"set rules=[]",
		"set maxFailures",
		"set quietStartup=yes",
		"--scope project set quietStartup=true",
		"unset",
		"unset maxFailures maxFailures",
		"unknown",
		"status extra",
		"show unknown",
		"--scope unknown show",
		"--scope",
		"--scope global --scope project show",
		'set actionTimeout="2s',
	]) {
		const parsed = parseCommand(command);
		assert.ok(parsed.kind === "error", command);
		assert.doesNotMatch(parsed.message, /\p{Script=Han}/u, command);
	}
	for (const action of ["status", "actions", "on", "off", "show", "set", "unset", "reload", "reset"]) {
		for (const line of helpText(action)
			.split("\n")
			.filter((line) => /^ {2}\/onward /.test(line)))
			assert.notEqual(parseCommand(line.trim().slice(8)).kind, "error", line);
	}
});

test("命令报错使用英文，正常帮助仍使用中文", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const notice = await h.command("set maxFailures=0");
	assert.match(notice, /maxFailures must be an integer/);
	assert.match(notice, /No changes made/);
	assert.doesNotMatch(notice, /\p{Script=Han}/u);
	assert.match(await h.command("set --help"), /用法/);
});

test("真实编辑器 Tab 补动作、作用域及新参数，帮助后不补全", async () => {
	assert.equal(await tab("/onward act"), "/onward actions ");
	assert.equal(await tab("/onward set maxF"), "/onward set maxFailures=");
	assert.equal(await tab("/onward --scope pro"), "/onward --scope project ");
	assert.equal(await tab("/onward set actionT"), "/onward set actionTimeout=");
	assert.equal(await tab("/onward set --help "), "/onward set --help ");
	assert.equal(completeArguments("set maxRetries="), null);
});

test("菜单默认改全局，选项目 set 时只填项目命令；取消不执行", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const notes = h.notes.length;
	await h.command("");
	assert.equal(h.notes.length, notes);
	assert.match(h.menus[0]!.title, /修改默认写入：全局设置/);
	h.pick = () => menuItems("project").find((item) => item.input.endsWith(" set"))!.label;
	await h.command("--scope project");
	assert.equal(h.editorText, "/onward --scope project set ");
});

test("status 区分待提交与已启动，show 只看配置，状态不会发送到模型", async () => {
	const h = harness({ config: { rules: [rule([stage(1, "pi.message", { prompt: "继续\n工作" })])] } });
	await h.emit("session_start", { reason: "startup" });
	assert.doesNotMatch(await h.command("status"), /连续失败|已启动续跑|onward\.json/);
	await h.emit("agent_before_settle", boundaryEvent(err()));
	assert.match(await h.command("status"), /提议已提交[\s\S]*连续失败\s+1 次/);
	assert.doesNotMatch(await h.command("status"), /已启动续跑/);
	assert.doesNotMatch(await h.command("show"), /当前状态|已启动续跑/);
	await h.emit("agent_start");
	assert.match(await h.command("status"), /已启动续跑\s+1 次/);
	assert.deepEqual(h.sent, []);
});

test("自定义消息渲染只显示正文，不添加规则、次数或标题", () => {
	const component = renderContinue(
		{
			customType: "pi-onward",
			content: "继续\n\n工作",
			display: true,
			details: { rule: "hidden-rule", failures: 3 },
			role: "custom",
			timestamp: 0,
		},
		{ expanded: true, outputPad: 0 } as never,
		{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as never,
	);
	assert.ok(component);
	const rendered = component.render(80).join("\n");
	assert.match(rendered, /继续[\s\S]*工作/);
	assert.doesNotMatch(rendered, /hidden-rule|pi-onward|3/);
});
