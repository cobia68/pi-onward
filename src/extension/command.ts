/**
 * `/onward <动作> [参数]`：动作在前，参数写成 `字段=值`，字段名和设置文件一样。`set` 全有或全无：任何一项
 * 不合法就一项都不写。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FIELD_NAMES, FIELDS, type Field, fieldNamed } from "../policy/policy.ts";
import type { Onward } from "./onward.ts";
import type { Settings, SettingsChange } from "./settings.ts";
import {
	COMMAND,
	changedNotice,
	commandErrorNotice,
	info,
	type Notice,
	rulesNotice,
	say,
	showNotice,
	statusNotice,
} from "./text.ts";

export type Command =
	| { kind: "status" | "help" | "reload" | "reset" }
	| { kind: "show"; rules: boolean }
	| { kind: "update"; change: SettingsChange }
	| { kind: "error"; message: string };

/** 每个动作：参数的写法和作用。用法、补全都从这张表来。 */
const ACTIONS: readonly { name: string; args: string; description: string }[] = [
	{ name: "status", args: "", description: "开关、设置文件、恢复前续跑了几次" },
	{ name: "on", args: "", description: "打开" },
	{ name: "off", args: "", description: "关掉" },
	{ name: "show", args: "[rules]", description: "各项参数和来源、规则、设置文件里的问题；rules 只看规则" },
	{ name: "set", args: "字段=值 …", description: "改设置文件顶层的参数，规则没写的字段用它；一项不合法就都不改" },
	{ name: "unset", args: "字段 …", description: "去掉参数，退回内置默认值" },
	{ name: "reload", args: "", description: "重新读设置文件（手改 rules 之后用）" },
	{ name: "reset", args: "", description: "去掉开关和参数，保留手写的 rules" },
];

const DESCRIPTION = `出错后按规则自动续跑：/${COMMAND} [${ACTIONS.map((item) => item.name).join("|")}|--help]`;

const USAGE = [
	...ACTIONS.map((item) => `/${COMMAND} ${pad(`${item.name} ${item.args}`, 18)}${item.description}`),
	"",
	"字段：",
	...FIELDS.map((item) => `  ${item.name.padEnd(13)}${item.syntax}　${item.description}`),
	"",
	`例如 /${COMMAND} set action=resend maxRetries=20 delay=5s,10s,30s；值里有空格时加双引号：prompt="接着做 {error}"`,
].join("\n");

/** 按终端里的宽度补空格：中文和全角字符占两格。 */
function pad(text: string, width: number): string {
	const used = [...text].reduce(
		(sum, char) =>
			sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1),
		0,
	);
	return text + " ".repeat(Math.max(1, width - used));
}

export function registerCommand(pi: ExtensionAPI, settings: Settings, onward: Onward): void {
	pi.registerCommand(COMMAND, {
		description: DESCRIPTION,
		getArgumentCompletions: (prefix) => completeArguments(prefix),
		handler: async (args, ctx) => {
			const notice = execute(parseCommand(args), settings, onward, ctx);
			// 不管是命令关的还是 reload 读到手改的关，关了就不该还有等着的续跑。
			if (!settings.config.enabled) onward.stop(ctx);
			say(ctx, notice);
		},
	});
}

function execute(command: Command, settings: Settings, onward: Onward, ctx: ExtensionContext): Notice {
	switch (command.kind) {
		case "status":
			return statusNotice(settings, onward.progress());
		case "help":
			return info(USAGE);
		case "error":
			return commandErrorNotice(command.message);
		case "show":
			return command.rules ? rulesNotice(settings.config) : showNotice(settings);
		case "reload":
			settings.reload();
			return statusNotice(settings, onward.progress());
		case "reset": {
			onward.stop(ctx);
			const saved = settings.reset();
			const kept = saved.kind === "saved" && Array.isArray(saved.value.rules) && saved.value.rules.length > 0;
			return changedNotice(
				saved,
				settings,
				onward.progress(),
				kept ? "（已恢复默认，手写的 rules 保留）" : "（已恢复默认）",
			);
		}
		case "update":
			return changedNotice(settings.update(command.change), settings, onward.progress());
	}
}

export function parseCommand(text: string): Command {
	const tokens = tokenize(text);
	if (typeof tokens === "string") return { kind: "error", message: tokens };
	if (tokens.includes("--help")) return { kind: "help" };
	const [first, ...rest] = tokens;
	if (first === undefined) return { kind: "status" };
	const action = first.toLowerCase();
	switch (action) {
		case "status":
		case "reload":
		case "reset":
			return none(action, rest) ?? { kind: action };
		case "on":
		case "off":
			return none(action, rest) ?? { kind: "update", change: { enabled: action === "on" } };
		case "show":
			if (!rest.length) return { kind: "show", rules: false };
			if (rest.length === 1 && rest[0]!.toLowerCase() === "rules") return { kind: "show", rules: true };
			return { kind: "error", message: "show 后面只能写 rules" };
		case "set":
			return parseSet(rest);
		case "unset":
			return parseUnset(rest);
		default:
			return { kind: "error", message: `不认识的动作 ${first}；可用 ${actionList()}` };
	}
}

/** 不带参数的动作带了参数。 */
function none(action: string, rest: string[]): Command | undefined {
	return rest.length ? { kind: "error", message: `${action} 不带参数` } : undefined;
}

function parseSet(tokens: string[]): Command {
	if (!tokens.length) return { kind: "error", message: `set 要写 字段=值；可用 ${FIELD_NAMES.join("、")}` };
	const problems: string[] = [];
	const values: Record<string, unknown> = {};
	for (const token of tokens) {
		const equals = token.indexOf("=");
		if (equals <= 0) {
			problems.push(`「${token}」写成 字段=值`);
			continue;
		}
		const key = token.slice(0, equals);
		const text = token.slice(equals + 1);
		const known = paramField(key);
		if (typeof known === "string") {
			problems.push(known);
			continue;
		}
		if (known.name in values) {
			problems.push(`${known.name} 写了两次`);
			continue;
		}
		const value = known.fromText(text);
		const read = known.read(value);
		if ("problem" in read) problems.push(`${known.name} ${read.problem}`);
		else values[known.name] = value;
	}
	return problems.length ? rejected(problems) : { kind: "update", change: { set: values } };
}

function parseUnset(tokens: string[]): Command {
	if (!tokens.length) return { kind: "error", message: `unset 要写字段名；可用 ${FIELD_NAMES.join("、")}` };
	const problems: string[] = [];
	const unset: string[] = [];
	for (const token of tokens) {
		const known = paramField(token);
		if (typeof known === "string") problems.push(known);
		else if (unset.includes(known.name)) problems.push(`${known.name} 写了两次`);
		else unset.push(known.name);
	}
	return problems.length ? rejected(problems) : { kind: "update", change: { unset } };
}

/** 参数字段；不是时说明为什么。 */
function paramField(key: string): Field | string {
	const lower = key.toLowerCase();
	if (lower === "rules") return "rules 要在设置文件里手写，改完 /onward reload";
	if (lower === "enabled") return "开关用 /onward on 或 off";
	return fieldNamed(key) ?? `不认识的字段 ${key}；可用 ${FIELD_NAMES.join("、")}`;
}

function rejected(problems: string[]): Command {
	return { kind: "error", message: `${problems.join("；")}。未做任何修改` };
}

function actionList(): string {
	return ACTIONS.map((item) => item.name).join("、");
}

/** 按空白分开，双引号里的空白不分；引号本身去掉。 */
function tokenize(text: string): string[] | string {
	const tokens: string[] = [];
	let current = "";
	let quoted = false;
	let started = false;
	for (const char of text.trim()) {
		if (char === '"') {
			quoted = !quoted;
			started = true;
		} else if (!quoted && /\s/.test(char)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (quoted) return "引号没有配对";
	if (started) tokens.push(current);
	return tokens;
}

interface Candidate {
	value: string;
	description: string;
	/** 选中后接着写：后面加空格，或停在 = 后面。 */
	more: boolean;
}

/** 补全：动作、show 的 rules、set 和 unset 的字段名、action 的取值。都写完了就不给，回车直接执行。 */
export function completeArguments(prefix: string): { value: string; label: string; description: string }[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	const current = tokens.pop() ?? "";
	const head = tokens.length ? `${tokens.join(" ")} ` : "";
	const shown = candidates(tokens, current).filter((item) =>
		item.value.toLowerCase().startsWith(current.toLowerCase()),
	);
	if (!shown.length || shown.some((item) => item.value.toLowerCase() === current.toLowerCase())) return null;
	return shown.map((item) => ({
		value: `${head}${item.value}${item.more && !item.value.endsWith("=") ? " " : ""}`,
		label: item.value,
		description: item.description,
	}));
}

function candidates(tokens: string[], current: string): Candidate[] {
	const action = tokens[0]?.toLowerCase();
	if (action === undefined)
		return ACTIONS.map((item) => ({ value: item.name, description: item.description, more: item.args !== "" }));
	if (action === "show" && tokens.length === 1) return [{ value: "rules", description: "只看规则", more: false }];
	if (action === "unset")
		return FIELDS.filter((item) => !tokens.includes(item.name)).map((item) => ({
			value: item.name,
			description: item.description,
			more: true,
		}));
	if (action !== "set") return [];
	const equals = current.indexOf("=");
	if (equals < 0)
		return FIELDS.map((item) => ({
			value: `${item.name}=`,
			description: `${item.syntax}：${item.description}`,
			more: true,
		}));
	const known = fieldNamed(current.slice(0, equals));
	return (known?.choices ?? []).map((choice) => ({
		value: `${known!.name}=${choice.value}`,
		description: choice.description,
		more: true,
	}));
}
