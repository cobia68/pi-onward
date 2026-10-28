import assert from "node:assert/strict";
import { test } from "node:test";
import { completeArguments, helpText, parseCommand } from "../../src/extension/command.ts";
import { harness } from "../support/fake-pi.ts";

const values = (prefix: string) => completeArguments(prefix)?.map((item) => item.value);
const ACTIONS = ["status", "on", "off", "show", "set", "unset", "reload", "reset"];

test("动作在前：status 是默认", () => {
	assert.deepEqual(parseCommand(""), { kind: "status" });
	assert.deepEqual(parseCommand(" status "), { kind: "status" });
	assert.deepEqual(parseCommand("show"), { kind: "show", rules: false });
	assert.deepEqual(parseCommand("show rules"), { kind: "show", rules: true });
	assert.deepEqual(parseCommand("reload"), { kind: "reload" });
	assert.deepEqual(parseCommand("RESET"), { kind: "reset" });
	assert.deepEqual(parseCommand("on"), { kind: "update", change: { enabled: true } });
	assert.deepEqual(parseCommand("off"), { kind: "update", change: { enabled: false } });
});

test("--help 写在哪都只看帮助：跟在动作后面是这个动作的帮助", () => {
	assert.deepEqual(parseCommand("--help"), { kind: "help" });
	assert.deepEqual(parseCommand(" --help "), { kind: "help" });
	for (const action of ACTIONS) assert.deepEqual(parseCommand(`${action} --help`), { kind: "help", topic: action });
	assert.deepEqual(parseCommand("--help set"), { kind: "help", topic: "set" });
	assert.deepEqual(parseCommand("SET --help"), { kind: "help", topic: "set" });
	// 后面写错了也只看帮助，不报错、不执行。
	assert.deepEqual(parseCommand("set maxRetries=0 colour=red --help"), { kind: "help", topic: "set" });
	assert.deepEqual(parseCommand("status now --help"), { kind: "help", topic: "status" });
	// 动作写错了：说有哪些动作。
	assert.equal(parseCommand("sett --help").kind, "error");
	// 引号里的 --help 是值，不是帮助。
	assert.deepEqual(parseCommand('set prompt="看 --help"'), {
		kind: "update",
		change: { set: { prompt: "看 --help" } },
	});
});

test("总帮助列出每个动作，字段留给 set --help", () => {
	const overall = helpText();
	for (const action of ACTIONS) assert.match(overall, new RegExp(`^ {2}${action}\\b`, "m"), action);
	assert.match(overall, /\/onward <动作> --help（只显示帮助，不执行）/);
	assert.match(overall, /字段和默认值：\/onward set --help/);
	assert.doesNotMatch(overall, /maxSameError/);
});

test("每个动作有自己的帮助：用法、说明；set、unset 列出字段和默认值", () => {
	for (const action of ACTIONS) {
		const help = helpText(action);
		assert.match(help, new RegExp(`^${action} — `), action);
		assert.match(help, new RegExp(`^用法：/onward ${action}`, "m"), action);
		assert.match(help, /^说明$/m, action);
		assert.equal(/^字段$/m.test(help), action === "set" || action === "unset", action);
	}
	const set = helpText("set");
	assert.match(set, /^用法：\/onward set 字段=值 …$/m);
	assert.match(set, /^ +message：发一条看得见的消息再接着跑（默认）$/m);
	assert.match(set, /^ +resend：静默重发同一个请求$/m, "只标默认的那个");
	assert.match(set, /^ +文字；默认：「继续」$/m);
	assert.match(set, /^ +1–50；默认：10$/m);
	assert.match(set, /；默认：3s\.\.15s$/m);
	assert.match(set, /^示例$/m);
	// 字段名一列按最长的 maxSameError 对齐。
	assert.match(helpText("unset"), /^ {2}delay {9}列表按顺序等/m);
	assert.equal(helpText("STATUS"), helpText("status"));
});

test("--help 不执行：不改设置", async () => {
	const h = harness();
	const before = await h.command("");
	assert.equal(await h.command("set maxRetries=5 --help"), helpText("set"));
	assert.equal(await h.command("off --help"), helpText("off"));
	assert.equal(await h.command("--help"), helpText());
	assert.equal(await h.command(""), before, "没有改");
});

test("出错时指到这个动作的帮助", async () => {
	const h = harness();
	assert.match(await h.command("set maxRetries=0"), /需要 1–50 的整数。未做任何修改；用法见 \/onward set --help$/);
	assert.match(await h.command("unset colour"), /；用法见 \/onward unset --help$/);
	assert.match(await h.command("status now"), /^onward：status 不带参数；用法见 \/onward status --help$/);
	assert.match(await h.command("show all"), /；用法见 \/onward show --help$/);
	assert.match(await h.command("sett"), /^onward：不认识的动作 sett；.*；用法见 \/onward --help$/);
});

test("set 字段=值：字段名和设置文件一样，大小写不敏感；值里有空格时加双引号", () => {
	const change = (text: string) => (parseCommand(text) as { change: unknown }).change;
	assert.deepEqual(change("set action=resend maxretries=20 delay=5s,10s,30s"), {
		set: { action: "resend", maxRetries: 20, delay: "5s,10s,30s" },
	});
	assert.deepEqual(change('set prompt="继续，第 {attempt} 次" maxSameError=3'), {
		set: { prompt: "继续，第 {attempt} 次", maxSameError: 3 },
	});
	assert.deepEqual(change("set delay=3s..15s"), { set: { delay: "3s..15s" } });
	assert.deepEqual(change("unset delay maxRetries"), { unset: ["delay", "maxRetries"] });
});

test("set 全有或全无：任何一项不对就一项都不改，问题一起说", () => {
	const bad = parseCommand("set maxRetries=0 delay=5 action=resend colour=red");
	assert.equal(bad.kind, "error");
	assert.match(
		(bad as { message: string }).message,
		/^maxRetries 需要 1–50 的整数；delay 写成 .*；不认识的字段 colour；可用 action、prompt、maxRetries、maxSameError、delay。未做任何修改$/,
	);
	for (const text of [
		"set",
		"set maxRetries",
		"set =3",
		"set maxRetries=3 maxRetries=4",
		"set rules=[]",
		"set enabled=false",
	])
		assert.equal(parseCommand(text).kind, "error", text);
	assert.match((parseCommand("set rules=[]") as { message: string }).message, /rules 要在设置文件里手写/);
	assert.match((parseCommand("unset enabled") as { message: string }).message, /开关用 \/onward on 或 off/);
	for (const text of ["unset", "unset foo", "status now", "show all", 'set prompt="x'])
		assert.equal(parseCommand(text).kind, "error", text);
});

test("不认识的动作：说明有哪些", () => {
	assert.deepEqual(parseCommand("10"), {
		kind: "error",
		message: "不认识的动作 10；可用 status、on、off、show、set、unset、reload、reset",
	});
});

test("补全：动作、字段名、action 的取值；后面还能写的补一个空格，写完了就不给", () => {
	assert.deepEqual(values("s"), ["status ", "show ", "set "]);
	assert.deepEqual(values("set "), [
		"set action=",
		"set prompt=",
		"set maxRetries=",
		"set maxSameError=",
		"set delay=",
		"set --help",
	]);
	assert.deepEqual(values("set action="), ["set action=message ", "set action=resend ", "set action=stop "]);
	assert.deepEqual(values("set maxRetries=5 de"), ["set maxRetries=5 delay="]);
	assert.deepEqual(values("unset delay "), [
		"unset delay action ",
		"unset delay prompt ",
		"unset delay maxRetries ",
		"unset delay maxSameError ",
		"unset delay --help",
	]);
	assert.deepEqual(values("show "), ["show rules ", "show --help"]);
	assert.equal(completeArguments("status"), null, "写完了：回车直接执行");
	assert.equal(completeArguments("set action=resend"), null);
});

test("补全：每个动作后面都给 --help；写了 --help 就什么都不给，有没有空格都一样", () => {
	assert.deepEqual(values(""), [...ACTIONS.map((action) => `${action} `), "--help"]);
	assert.deepEqual(values("--"), ["--help"]);
	for (const action of ["status", "on", "off", "reload", "reset"]) {
		assert.deepEqual(values(`${action} `), [`${action} --help`], action);
		assert.deepEqual(values(`${action} -`), [`${action} --help`], action);
	}
	assert.deepEqual(values("show rules "), ["show rules --help"]);
	assert.deepEqual(values("set --"), ["set --help"]);
	assert.deepEqual(values("unset action prompt maxRetries maxSameError delay "), [
		"unset action prompt maxRetries maxSameError delay --help",
	]);
	for (const text of [
		"--help",
		"--help ",
		"--help s",
		"set --help",
		"set --help ",
		"set --help a",
		"unset delay --help ",
		"show --help ",
		"status --help ",
	])
		assert.equal(completeArguments(text), null, text);
});

test("补全：写错了的地方什么都不给，--help 也不给", () => {
	for (const text of ["sett ", "status now ", "show all ", "show rules x", "set foo=", "set Action=resend action="])
		assert.equal(completeArguments(text), null, text);
});

test("补全：写过的字段不再给，大小写不敏感", () => {
	assert.equal(completeArguments("set action=resend ac"), null);
	assert.deepEqual(values("set action=resend "), [
		"set action=resend prompt=",
		"set action=resend maxRetries=",
		"set action=resend maxSameError=",
		"set action=resend delay=",
		"set action=resend --help",
	]);
	assert.deepEqual(values("unset Delay "), [
		"unset Delay action ",
		"unset Delay prompt ",
		"unset Delay maxRetries ",
		"unset Delay maxSameError ",
		"unset Delay --help",
	]);
});

test("补全：引号里的值不补，正在写的词前面原样保留", () => {
	assert.equal(completeArguments('set prompt="继续 m'), null, "引号没配对：还在写值");
	assert.equal(completeArguments('set prompt="继续 '), null);
	assert.equal(completeArguments('set prompt="继续"'), null, "值写完了：回车直接执行");
	assert.deepEqual(values('set prompt="a  b" ma'), [
		'set prompt="a  b" maxRetries=',
		'set prompt="a  b" maxSameError=',
	]);
	assert.deepEqual(values("set  a"), ["set  action="]);
});
