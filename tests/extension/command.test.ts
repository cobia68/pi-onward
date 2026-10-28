import assert from "node:assert/strict";
import { test } from "node:test";
import { completeArguments, parseCommand } from "../../src/extension/command.ts";

test("动作在前：status 是默认，--help 写在哪都行", () => {
	assert.deepEqual(parseCommand(""), { kind: "status" });
	assert.deepEqual(parseCommand(" status "), { kind: "status" });
	assert.deepEqual(parseCommand("--help"), { kind: "help" });
	assert.deepEqual(parseCommand("set --help"), { kind: "help" });
	assert.deepEqual(parseCommand("show"), { kind: "show", rules: false });
	assert.deepEqual(parseCommand("show rules"), { kind: "show", rules: true });
	assert.deepEqual(parseCommand("reload"), { kind: "reload" });
	assert.deepEqual(parseCommand("RESET"), { kind: "reset" });
	assert.deepEqual(parseCommand("on"), { kind: "update", change: { enabled: true } });
	assert.deepEqual(parseCommand("off"), { kind: "update", change: { enabled: false } });
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

test("补全：动作、字段名、action 的取值；写完了就不给", () => {
	const values = (prefix: string) => completeArguments(prefix)?.map((item) => item.value);
	assert.deepEqual(values("s"), ["status", "show ", "set "]);
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
	assert.deepEqual(values("show "), ["show rules", "show --help"]);
	assert.equal(completeArguments("status"), null, "写完了：回车直接执行");
	assert.equal(completeArguments("reload "), null);
});

test("补全：--help 在最前面，set/unset/show 之后也给，写完了就不给", () => {
	const values = (prefix: string) => completeArguments(prefix)?.map((item) => item.value);
	assert.deepEqual(values(""), ["status", "on", "off", "show ", "set ", "unset ", "reload", "reset", "--help"]);
	assert.deepEqual(values("--"), ["--help"]);
	assert.equal(completeArguments("--help"), null, "写完了：回车直接执行");
	assert.equal(completeArguments("set --help"), null);
	assert.deepEqual(values("set --"), ["set --help"]);
});

test("补全：写过的字段不再给，大小写不敏感", () => {
	const values = (prefix: string) => completeArguments(prefix)?.map((item) => item.value);
	assert.equal(completeArguments("set action=resend ac"), null);
	assert.deepEqual(values("set action=resend "), [
		"set action=resend prompt=",
		"set action=resend maxRetries=",
		"set action=resend maxSameError=",
		"set action=resend delay=",
		"set action=resend --help",
	]);
	assert.equal(completeArguments("set Action=resend action="), null, "写过的字段也不给取值");
	assert.deepEqual(values("unset Delay "), [
		"unset Delay action ",
		"unset Delay prompt ",
		"unset Delay maxRetries ",
		"unset Delay maxSameError ",
		"unset Delay --help",
	]);
});

test("补全：引号里的值不补，正在写的词前面原样保留", () => {
	const values = (prefix: string) => completeArguments(prefix)?.map((item) => item.value);
	assert.equal(completeArguments('set prompt="继续 m'), null, "引号没配对：还在写值");
	assert.equal(completeArguments('set prompt="继续 '), null);
	assert.equal(completeArguments('set prompt="继续"'), null, "值写完了：回车直接执行");
	assert.deepEqual(values('set prompt="a  b" ma'), [
		'set prompt="a  b" maxRetries=',
		'set prompt="a  b" maxSameError=',
	]);
	assert.deepEqual(values("set  a"), ["set  action="]);
});
