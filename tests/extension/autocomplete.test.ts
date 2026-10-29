/** `/onward` 的参数里按 Tab：在 pi-tui 真实的编辑器里按键。 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { CombinedAutocompleteProvider, Editor, type TUI } from "@earendil-works/pi-tui";
import { argumentTabCompletion, isArgumentTab } from "../../src/extension/autocomplete.ts";
import { completeArguments } from "../../src/extension/command.ts";
import { harness, tempDir } from "../support/fake-pi.ts";

// 当前目录里只有 status-notes/：补成它就是补了文件名。
const cwd = tempDir();
mkdirSync(join(cwd, "status-notes"));
after(() => rmSync(cwd, { recursive: true, force: true }));

/** 和 pi 里一样：pi-tui 自带的命令和文件补全，外面包一层 argumentTabCompletion。 */
function editor(text = ""): Editor {
	const id = (s: string) => s;
	const editor = new Editor({ requestRender() {}, terminal: { rows: 40 } } as unknown as TUI, {
		borderColor: id,
		selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
	});
	const commands = [{ name: "onward", description: "", getArgumentCompletions: completeArguments }];
	editor.setAutocompleteProvider(argumentTabCompletion(new CombinedAutocompleteProvider(commands, cwd)));
	editor.setText(text);
	return editor;
}

/** 按一下键，等补全算完。 */
async function press(editor: Editor, key: string): Promise<void> {
	editor.handleInput(key);
	await tick();
}

/** 写好 `text`，按 `times` 下 Tab。 */
async function tab(text: string, times = 1): Promise<{ text: string; listed: boolean; menu: string }> {
	const e = editor(text);
	for (let i = 0; i < times; i++) await press(e, "\t");
	return { text: e.getText(), listed: e.isShowingAutocomplete(), menu: e.render(120).join("\n") };
}

test("只有第一行、命令名写完之后才算 /onward 的参数", () => {
	const at = (text: string) => isArgumentTab([text], 0, text.length);
	assert.equal(at("/onward "), true);
	assert.equal(at("/onward set a"), true);
	assert.equal(at("  /onward show "), true);
	assert.equal(at("/onward"), false, "还在写命令名");
	assert.equal(at("/onward\tstatus"), false, "pi 的命令名到空格为止");
	assert.equal(at("/onwar "), false);
	assert.equal(at("/onwardx "), false);
	assert.equal(at("看看 /onward "), false);
	assert.equal(isArgumentTab(["备注", "/onward "], 1, 8), false, "pi 只把第一行当命令读");
	assert.equal(isArgumentTab(["/onward show"], 0, 3), false, "光标还在命令名里");
});

test("命令名后面按 Tab：列出动作，不列文件", async () => {
	const top = await tab("/onward ");
	assert.equal(top.text, "/onward ");
	assert.equal(top.listed, true, "紧跟在命令名后面也列出来");
	assert.match(top.menu, /→ status {2}现在/, "说明紧跟在名字后面，不拉到固定宽度");
	const some = await tab("/onward s");
	assert.equal(some.text, "/onward s", "不补成 /onward status-notes/");
	assert.equal(some.listed, true);
	assert.match(some.menu, /→ status/);
	assert.match(some.menu, /^ {2}show {4}各项/m, "说明对齐在同一列");
	assert.doesNotMatch(some.menu, /status-notes/);
});

test("补完一层接着按 Tab，补下一层", async () => {
	// 只有一个候选时 Tab 直接补上。
	assert.equal((await tab("/onward se")).text, "/onward set ");
	const fields = await tab("/onward se", 2);
	assert.equal(fields.text, "/onward set ");
	assert.equal(fields.listed, true);
	assert.match(fields.menu, /→ action= {8}message/, "说明紧跟在最长的字段名后面");
	assert.doesNotMatch(fields.menu, /status-notes/);
	assert.equal((await tab("/onward set a")).text, "/onward set action=");
	const choices = await tab("/onward set a", 2);
	assert.equal(choices.listed, true);
	assert.match(choices.menu, /→ action=message/);
	assert.match(choices.menu, /^ {2}action=resend/m);
	// 几个候选时第一下列出来，第二下补上选中的；后面还能写 --help，所以带一个空格。
	assert.equal((await tab("/onward s", 2)).text, "/onward status ");
	assert.equal((await tab("/onward set action=r")).text, "/onward set action=resend ");
});

test("写完的词后面按 Tab：什么都不补，即使有文件名对得上", async () => {
	for (const text of ["/onward status", "/onward set action=resend", "/onward show rules"]) {
		const done = await tab(text);
		assert.equal(done.text, text);
		assert.equal(done.listed, false, text);
	}
});

test("写了 --help 就是结束：再按 Tab 什么都不补，有没有空格都一样", async () => {
	for (const text of [
		"/onward --help",
		"/onward --help ",
		"/onward set --help",
		"/onward set --help ",
		"/onward set action=resend --help ",
		"/onward status --help ",
	]) {
		const done = await tab(text);
		assert.equal(done.text, text, "不补字段，也不补文件名");
		assert.equal(done.listed, false, text);
	}
});

test("没写 --help 之前：每个动作后面都给它，只剩它时 Tab 直接补上", async () => {
	assert.equal((await tab("/onward reload ")).text, "/onward reload --help");
	assert.equal((await tab("/onward st", 2)).text, "/onward status --help", "补完动作再按一下");
	assert.equal((await tab("/onward show rules ")).text, "/onward show rules --help");
	assert.equal((await tab("/onward set -")).text, "/onward set --help", "--help 是结束，不带空格");
	const show = await tab("/onward show ");
	assert.equal(show.listed, true);
	assert.match(show.menu, /→ rules/);
	assert.match(show.menu, /^ {2}--help/m);
});

test("引号里的值：打字、按 Tab 都不补", async () => {
	const e = editor('/onward set prompt="');
	let listed = false;
	for (const char of "继续 make sta") {
		await press(e, char);
		listed ||= e.isShowingAutocomplete();
	}
	assert.equal(listed, false, "打到 m 时不弹 maxRetries= 这些字段名");
	await press(e, "\t");
	assert.equal(e.getText(), '/onward set prompt="继续 make sta', "Tab 也不补成 status-notes/");
	assert.equal(e.isShowingAutocomplete(), false);
});

test("引号配好之后接着补，引号里的空白不动", async () => {
	const e = editor('/onward set prompt="接着做  第 {attempt} 次" ');
	await press(e, "m");
	assert.equal(e.isShowingAutocomplete(), true);
	await press(e, "\t");
	assert.equal(e.getText(), '/onward set prompt="接着做  第 {attempt} 次" maxRetries=');
});

test("别处按 Tab 还是补文件名", async () => {
	assert.equal((await tab("看看 stat")).text, "看看 status-notes/");
	assert.equal((await tab("备注\n/onward stat")).text, "备注\n/onward status-notes/", "第二行不是命令");
	assert.equal((await tab("/onwardx stat")).text, "/onwardx status-notes/");
});

test("每次 session_start 都装上补全", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.emit("session_start", { reason: "reload" });
	assert.deepEqual(h.autocomplete, [argumentTabCompletion, argumentTabCompletion]);
});
