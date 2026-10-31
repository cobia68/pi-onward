/**
 * `/onward <动作> [参数]`：动作在前，参数写成 `字段=值`，字段名和设置文件一样。动作、字段、取值和选项都区分大小写，
 * 和设置文件、pi 自己的命令名一样。`set` 全有或全无：任何一项不合法就一项都不写。不写动作时弹出菜单，标题是现在的状态。
 *
 * `--help` 是结束：写在哪都只显示帮助、不执行，跟在动作后面时显示这个动作的帮助。补全在每个动作后面都给它，
 * 写了它之后什么都不再给，后面有没有空格都一样。
 *
 * 看或改哪一份设置文件由 `--scope <global|project>` 定，和 wecom-aibot 的 `config --scope <层> <动作>` 一样写在动作前：
 * `/onward --scope project set maxRetries=3`，也可以写成 `--scope=project`。改设置的动作（on、off、set、unset、reset）
 * 不写就是全局，和 pi 的 `install`、`config` 不加 `--local` 时一样：同一条命令总是写同一个文件，仓库里的文件要写明才改。
 * show 不写时看合并后的结果，写了只看那一份写了什么。写在动作后不执行，报错给出正确的写法；只写 `--scope` 不写动作时，
 * 弹出这一份的菜单，`/onward` 的菜单里也有进到每一份的项。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isActive } from "../policy/config.ts";
import { DEFAULT_POLICY, FIELD_NAMES, FIELDS, type Field, fieldNamed } from "../policy/policy.ts";
import type { Onward } from "./onward.ts";
import { COMMAND_KEYS, SCOPES, type Scope, type Settings, type SettingsChange } from "./settings.ts";
import {
	COMMAND,
	changedNotice,
	columns,
	commandErrorNotice,
	info,
	layerMenuText,
	layerNotice,
	menuTitle,
	type Notice,
	resetLine,
	rulesNotice,
	SCOPE,
	say,
	scopeLine,
	section,
	shadowLine,
	showNotice,
	statusNotice,
	table,
} from "./text.ts";

/**
 * `topic`：帮助或出错是关于哪个动作的，没有时是总帮助。`choose`：没写动作，弹菜单；写了 `--scope` 时只列改这一份的。
 * `scope`：改哪一份设置文件。
 */
export type Command =
	| { kind: "choose"; scope?: Scope }
	| { kind: "status" | "reload" }
	| { kind: "reset"; scope: Scope }
	| { kind: "help"; topic?: string }
	| { kind: "show"; rules: boolean; scope?: Scope }
	| { kind: "update"; scope: Scope; change: SettingsChange }
	| { kind: "error"; message: string; topic?: string };

const HELP = "--help";

/** 改设置的动作的帮助里都有这一行。不写路径：设置文件放在哪只由 index.ts 决定，实际的路径在 status 里。 */
const SCOPE_HELP = `${SCOPE} 写在动作前：不写或 global 改全局设置，project 改当前目录的项目级设置；两份在哪见 /${COMMAND} status`;
/** 去掉参数的动作：去掉之后按什么走。 */
const SCOPE_FALLBACK = "去掉之后继承下一层：项目级的退回全局，全局的退回内置默认值";

interface ActionSpec {
	name: string;
	/** 动作后面参数的写法；没有参数时为空。 */
	args: string;
	/** 一句话：总帮助和补全里用。 */
	description: string;
	/** 这个动作的帮助里多说的。 */
	details: readonly string[];
	/** 帮助里列出字段表：set、unset。 */
	fields?: boolean;
	/** 前面能写 --scope：`write` 改这一份，`read` 只看这一份。 */
	scoped?: "write" | "read";
	examples?: readonly string[];
}

/** 每个动作：参数的写法和作用。帮助、补全都从这张表来。 */
const ACTIONS: readonly ActionSpec[] = [
	{
		name: "status",
		args: "",
		description: "现在会不会续跑、规则没写的参数、设置文件",
		details: [
			"第一行说现在会不会续跑；正在续跑时下一行是进度",
			"下面是规则没写的参数（做法、上限、间隔），以及全局、项目级设置文件在哪",
			`设置文件有问题时只说有几处，详情用 /${COMMAND} show`,
		],
	},
	{
		name: "on",
		args: "",
		description: "打开",
		details: ["在设置文件里写 enabled: true", `设置文件有问题时打开了也不续跑：先改好，再 /${COMMAND} reload`],
		scoped: "write",
	},
	{
		name: "off",
		args: "",
		description: "关掉",
		details: ["在设置文件里写 enabled: false", "正在等的续跑立刻打断，计数清零"],
		scoped: "write",
	},
	{
		name: "show",
		args: "[rules]",
		description: "各项参数和来源、规则、设置文件里的问题；rules 只看规则",
		details: [
			"每个参数的值，以及它来自全局设置、项目级设置还是内置默认值",
			"规则按顺序列出，第一条命中的生效；停用的标出来",
			"设置文件有问题时不列规则，只列问题",
			`写了 ${SCOPE} 时只看那一份设置文件写了什么，不合并、不填默认值`,
		],
		scoped: "read",
		examples: [`/${COMMAND} show rules`, `/${COMMAND} ${SCOPE} project show`],
	},
	{
		name: "set",
		args: "字段=值 …",
		description: "改设置文件顶层的参数，规则没写的字段用它；一项不合法就都不改",
		details: [
			"可以一次写几个：先全部检查，有一项不合法就一项都不改，问题一起说",
			'值里有空格时加双引号：prompt="接着做，第 {attempt} 次"',
			`rules 只能在设置文件里手写，改完 /${COMMAND} reload；开关用 /${COMMAND} on、off`,
		],
		fields: true,
		scoped: "write",
		examples: [
			`/${COMMAND} set action=resend maxRetries=20 delay=5s,10s,30s`,
			`/${COMMAND} set prompt="接着做 {error}"`,
			`/${COMMAND} ${SCOPE} project set maxRetries=3`,
		],
	},
	{
		name: "unset",
		args: "字段 …",
		description: "去掉开关或参数，继承下一层",
		details: [
			"可以一次写几个，开关 enabled 也能去掉；有不认识或写了两次的字段就一项都不改",
			"规则里写的同名字段不受影响",
			SCOPE_FALLBACK,
		],
		fields: true,
		scoped: "write",
		examples: [`/${COMMAND} unset delay maxRetries`, `/${COMMAND} ${SCOPE} project unset enabled`],
	},
	{
		name: "reload",
		args: "",
		description: "重新读设置文件（手改 rules 之后用）",
		details: ["全局、项目级都重读，读完显示和 status 一样的状态", "读到关着或有问题的设置时，正在等的续跑立刻打断"],
	},
	{
		name: "reset",
		args: "",
		description: "去掉开关和参数，保留手写的 rules",
		details: ["开关和参数都去掉；rules 和其他手写的内容留着", "正在等的续跑立刻打断，计数清零", SCOPE_FALLBACK],
		scoped: "write",
	},
];

const DESCRIPTION = `出错后按规则自动续跑（不写动作时弹出菜单，${HELP} 查看用法）`;

export function registerCommand(pi: ExtensionAPI, settings: Settings, onward: Onward): void {
	pi.registerCommand(COMMAND, {
		description: DESCRIPTION,
		getArgumentCompletions: (prefix) => completeArguments(prefix),
		handler: async (args, ctx) => {
			let command = parseCommand(args);
			// 菜单里选了「--scope <层> …」时接着弹这一份的菜单；这一份的菜单里不再有这种项。
			while (command.kind === "choose") {
				const picked = await choose(ctx, settings, command.scope);
				if (picked === undefined) return;
				command = parseCommand(picked);
			}
			const notice = execute(command, settings, onward, ctx);
			// 不管是命令关的、还是 reload 读到手改的关或有问题的设置，不生效了就不该还有等着的续跑。
			if (!isActive(settings.config)) onward.stop(ctx);
			say(ctx, notice);
		},
	});
}

/**
 * `/onward` 不写动作：弹出菜单，标题是现在的状态。返回选中的命令；要写参数的（set、unset）填进输入框接着写，
 * 返回 undefined。写了 `--scope` 时只列改这一份的动作，选中的命令带着它。没有界面时不弹，什么都不做。
 */
async function choose(ctx: ExtensionContext, settings: Settings, scope?: Scope): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const items = menuItems(scope);
	const label = await ctx.ui.select(
		menuTitle(settings, scope),
		items.map((item) => item.label),
	);
	const picked = items.find((item) => item.label === label);
	if (!picked?.fill) return picked?.input;
	ctx.ui.setEditorText(`/${COMMAND} ${picked.input} `);
	return undefined;
}

/**
 * 每个动作一项，再是进到每一份设置的菜单的 `--scope <层> …`，最后是 --help；和帮助里的动作表一样只写名字，参数留给
 * 各自动作的帮助。`fill`：参数非写不可。写了 `scope` 时是这一份的菜单：只列能写 --scope 的动作，`input` 带上
 * `--scope <scope>`。
 */
export function menuItems(scope?: Scope): { label: string; input: string; fill: boolean }[] {
	const actions = scope ? ACTIONS.filter((item) => item.scoped) : ACTIONS;
	const layers = scope ? [] : SCOPES;
	const labels = columns([
		...actions.map((item): [string, string] => [item.name, item.description]),
		...layers.map((layer): [string, string] => [`${SCOPE} ${layer} …`, layerMenuText(layer)]),
		[HELP, "显示帮助"],
	]);
	return [
		...actions.map((item, index) => ({
			label: labels[index]!,
			input: scope ? `${SCOPE} ${scope} ${item.name}` : item.name,
			fill: item.args !== "" && !item.args.startsWith("["),
		})),
		...layers.map((layer, index) => ({
			label: labels[actions.length + index]!,
			input: `${SCOPE} ${layer}`,
			fill: false,
		})),
		{ label: labels.at(-1)!, input: HELP, fill: false },
	];
}

function execute(
	command: Exclude<Command, { kind: "choose" }>,
	settings: Settings,
	onward: Onward,
	ctx: ExtensionContext,
): Notice {
	switch (command.kind) {
		case "status":
			return statusNotice(settings, onward.progress());
		case "help":
			return info(helpText(command.topic));
		case "error":
			return commandErrorNotice(command.message, command.topic);
		case "show":
			if (command.scope) return layerNotice(settings, command.scope, command.rules);
			return command.rules ? rulesNotice(settings) : showNotice(settings);
		case "reload":
			settings.reload();
			return statusNotice(settings, onward.progress());
		case "reset": {
			onward.stop(ctx);
			const saved = settings.reset(command.scope);
			const kept = saved.kind === "saved" && Array.isArray(saved.value.rules) && saved.value.rules.length > 0;
			const done = note(resetLine(settings, command.scope, kept), shadowLine(settings, command.scope, COMMAND_KEYS));
			return changedNotice(saved, settings, onward.progress(), done);
		}
		case "update": {
			const saved = settings.update(command.scope, command.change);
			const done = note(
				scopeLine(settings, command.scope),
				shadowLine(settings, command.scope, changedKeys(command.change)),
			);
			return changedNotice(saved, settings, onward.progress(), done);
		}
	}
}

/** 跟在标题后面的几行；都没有时是 undefined。 */
function note(...lines: (string | undefined)[]): string | undefined {
	const kept = lines.filter((line): line is string => line !== undefined);
	return kept.length ? kept.join("\n") : undefined;
}

/** 这次改到的开关和参数。 */
function changedKeys(change: SettingsChange): string[] {
	return [
		...(change.enabled === undefined ? [] : ["enabled"]),
		...Object.keys(change.set ?? {}),
		...(change.unset ?? []),
	];
}

export function parseCommand(text: string): Command {
	const tokens = tokenize(text);
	if (typeof tokens === "string") return { kind: "error", message: tokens };
	const { words, at, value, count } = splitScope(tokens);
	if (tokens.includes(HELP)) {
		const [first] = words;
		if (first === undefined) return { kind: "help" };
		const spec = actionNamed(first);
		return spec ? { kind: "help", topic: spec.name } : unknownAction(first);
	}
	const [first, ...rest] = words;
	const spec = first === undefined ? undefined : actionNamed(first);
	const topic = spec && { topic: spec.name };
	if (count > 1) return { kind: "error", message: `${SCOPE} 写了两次`, ...topic };
	const scope = count ? scopeNamed(value) : "global";
	// 先看 --scope 的值：`--scope set …` 是漏写了值，不是动作写错了。
	if (scope === undefined)
		return {
			kind: "error",
			message: `${SCOPE} ${value === undefined ? "后面要写" : "只能是"} ${SCOPES.join(" 或 ")}`,
			...topic,
		};
	if (first !== undefined && !spec) return unknownAction(first);
	if (count && spec && !spec.scoped) return { kind: "error", message: scopedOnly(), topic: spec.name };
	// --scope 是命令的目标，写在动作前；写在别处不执行，给出正确的写法。
	if (count && at !== 0)
		return {
			kind: "error",
			message: `${SCOPE} 要写在动作前：/${COMMAND} ${[SCOPE, scope, ...words.map(quoted)].join(" ")}`,
			...topic,
		};
	if (!spec) return count ? { kind: "choose", scope } : { kind: "choose" };
	const action = spec.name;
	switch (action) {
		case "status":
		case "reload":
			return none(action, rest) ?? { kind: action };
		case "reset":
			return none(action, rest) ?? { kind: "reset", scope };
		case "on":
		case "off":
			return none(action, rest) ?? { kind: "update", scope, change: { enabled: action === "on" } };
		case "show": {
			// 不写 --scope 是合并后的结果，不是全局那一份。
			const only = count ? { scope } : {};
			if (!rest.length) return { kind: "show", rules: false, ...only };
			if (rest.length === 1 && rest[0] === "rules") return { kind: "show", rules: true, ...only };
			return { kind: "error", message: "show 后面只能写 rules", topic: "show" };
		}
		case "set":
			return parseSet(rest, scope);
		case "unset":
			return parseUnset(rest, scope);
		default:
			return unknownAction(first!);
	}
}

/**
 * 把 `--scope <值>`、`--scope=<值>` 从词里拿出来。`at` 是第一个 `--scope` 前面有几个别的词：
 * 只有 0 是写在动作前；`value` 是它的值，没写时是 undefined；`count` 是写了几次。`-` 开头的词（如 --help）不算它的值。
 */
function splitScope(tokens: readonly string[]): { words: string[]; at: number; value?: string; count: number } {
	const words: string[] = [];
	let at = -1;
	let value: string | undefined;
	let count = 0;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === HELP) continue;
		const option = scopeOption(token);
		if (!option) {
			words.push(token);
			continue;
		}
		count++;
		let own = option.value;
		const next = tokens[i + 1];
		if (!option.inline && next !== undefined && !next.startsWith("-")) {
			own = next;
			i++;
		}
		if (count === 1) {
			at = words.length;
			value = own || undefined;
		}
	}
	return { words, at, ...(value !== undefined && { value }), count };
}

/** 这个词是 `--scope` 或 `--scope=<值>` 时：`inline` 是值写在 = 后面（可能是空的）。 */
function scopeOption(token: string): { inline: boolean; value?: string } | undefined {
	const match = /^--scope(?:=(.*))?$/.exec(token);
	if (!match) return undefined;
	return match[1] === undefined ? { inline: false } : { inline: true, value: match[1] };
}

function scopeNamed(value: string | undefined): Scope | undefined {
	return SCOPES.find((scope) => scope === value);
}

/** 给出正确写法时，含空白的词重新加上引号。 */
function quoted(word: string): string {
	if (!/\s/.test(word)) return word;
	const equals = word.indexOf("=");
	return equals > 0 ? `${word.slice(0, equals + 1)}"${word.slice(equals + 1)}"` : `"${word}"`;
}

function scopedOnly(): string {
	return `${SCOPE} 只用于 ${scopedActions()}`;
}

/** 能写 --scope 的动作；`write`：只要改设置的。 */
function scopedActions(only?: "write"): string {
	return ACTIONS.filter((item) => (only ? item.scoped === only : item.scoped))
		.map((item) => item.name)
		.join("、");
}

function unknownAction(word: string): Command {
	return { kind: "error", message: `不认识的动作 ${word}；可用 ${actionList()}` };
}

/** 不带参数的动作带了参数。 */
function none(action: string, rest: string[]): Command | undefined {
	return rest.length ? { kind: "error", message: `${action} 不带参数`, topic: action } : undefined;
}

function parseSet(tokens: string[], scope: Scope): Command {
	if (!tokens.length)
		return { kind: "error", message: `set 要写 字段=值；可用 ${FIELD_NAMES.join("、")}`, topic: "set" };
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
		const known = paramField(key, scope);
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
	return problems.length ? rejected(problems, "set") : { kind: "update", scope, change: { set: values } };
}

/**
 * unset 能去掉的：参数，和开关 enabled。开关有两份设置时也要能去掉：去掉项目级的才继承全局的。
 */
function parseUnset(tokens: string[], scope: Scope): Command {
	if (!tokens.length)
		return { kind: "error", message: `unset 要写字段名；可用 ${COMMAND_KEYS.join("、")}`, topic: "unset" };
	const problems: string[] = [];
	const unset: string[] = [];
	for (const token of tokens) {
		const key = unsetKey(token, scope);
		if ("problem" in key) problems.push(key.problem);
		else if (unset.includes(key.name)) problems.push(`${key.name} 写了两次`);
		else unset.push(key.name);
	}
	return problems.length ? rejected(problems, "unset") : { kind: "update", scope, change: { unset } };
}

function unsetKey(token: string, scope: Scope): { name: string } | { problem: string } {
	if (token === "enabled") return { name: "enabled" };
	const known = paramField(token, scope, COMMAND_KEYS);
	return typeof known === "string" ? { problem: known } : { name: known.name };
}

/**
 * 参数字段；不是时说明为什么。开关的提示写同一份的写法。`names` 是这个动作能写的字段，不认识时列出来。
 */
function paramField(key: string, scope: Scope, names: readonly string[] = FIELD_NAMES): Field | string {
	if (key === "rules") return `rules 要在设置文件里手写，改完 /${COMMAND} reload`;
	if (key === "enabled") return `开关用 /${COMMAND} ${scope === "project" ? `${SCOPE} project ` : ""}on 或 off`;
	return fieldNamed(key) ?? `不认识的字段 ${key}；可用 ${names.join("、")}`;
}

function rejected(problems: string[], topic: string): Command {
	return { kind: "error", message: `${problems.join("；")}。未做任何修改`, topic };
}

function actionList(): string {
	return ACTIONS.map((item) => item.name).join("、");
}

function actionNamed(name: string): ActionSpec | undefined {
	return ACTIONS.find((item) => item.name === name);
}

// ── 帮助 ──

/** `topic` 是动作名：这个动作的帮助；没有时是总帮助。 */
export function helpText(topic?: string): string {
	const spec = topic === undefined ? undefined : actionNamed(topic);
	return spec ? actionHelp(spec) : overallHelp();
}

function overallHelp(): string {
	return [
		"onward — 出错后按规则自动续跑",
		`用法：/${COMMAND} [${SCOPE} <${SCOPES.join("|")}>] [动作] [参数] [${HELP}]`,
		...section("动作", table(ACTIONS.map((item) => [item.name, item.description]))),
		"",
		`  不写动作时弹出菜单，标题是现在的状态；菜单里的 ${SCOPE} <层> … 进到只看、只改那一份的菜单`,
		`  ${scopedActions("write")} 改哪一份设置由 ${SCOPE} 定，写在动作前：不写或 global 是全局，project 是当前目录的项目级`,
		`  show 不写 ${SCOPE} 时看合并后的结果，写了只看那一份`,
		`  每个动作的用法：/${COMMAND} <动作> ${HELP}（只显示帮助，不执行）`,
		`  字段和默认值：/${COMMAND} set ${HELP}`,
	].join("\n");
}

function actionHelp(spec: ActionSpec): string {
	return [
		`${spec.name} — ${spec.description}`,
		`用法：/${COMMAND} ${usage(spec)}`,
		...section(
			"说明",
			[...spec.details, ...(spec.scoped === "write" ? [SCOPE_HELP] : [])].map((line) => `  ${line}`),
		),
		...(spec.fields ? section("字段", table(FIELDS.map((item) => [item.name, fieldHelp(item)]))) : []),
		...section(
			"示例",
			(spec.examples ?? []).map((line) => `  ${line}`),
		),
	].join("\n");
}

/** 能写 --scope 的动作前面写着 `[--scope <global|project>]`。 */
function usage(spec: ActionSpec): string {
	const words = [spec.scoped ? `[${SCOPE} <${SCOPES.join("|")}>]` : "", spec.name, spec.args];
	return words.filter(Boolean).join(" ");
}

/** 作用一行，写法和默认值一行；有固定取值的逐个列出，标出默认的那个。 */
function fieldHelp(item: Field): string {
	const fallback = DEFAULT_POLICY[item.name];
	const values = item.choices
		? item.choices.map(
				(choice) => `${choice.value}：${choice.description}${choice.value === fallback ? "（默认）" : ""}`,
			)
		: [`${item.syntax}；默认：${item.show(fallback)}`];
	return [item.description, ...values].join("\n");
}

// ── 分词 ──

/** 按空白分开，双引号里的空白不分；引号本身去掉。 */
function tokenize(text: string): string[] | string {
	const { words, quoted } = scan(text);
	return quoted ? "引号没有配对" : words;
}

/** 执行和补全共用。`start` 是正在写的词在原文里的起点，以空白结尾时就是末尾；`quoted`：引号到末尾还没配对。 */
function scan(text: string): { words: string[]; start: number; quoted: boolean } {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quoted = false;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '"') {
			quoted = !quoted;
			started = true;
		} else if (!quoted && /\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
			start = i + 1;
		} else {
			word += char;
			started = true;
		}
	}
	if (started) words.push(word);
	return { words, start, quoted };
}

// ── 补全 ──

interface Candidate {
	value: string;
	description: string;
}

/**
 * 补全：动作前的 --scope 和它的取值、动作、show 的 rules、set 和 unset 的字段名、action 的取值，以及每个动作后面的
 * --help。返回的 value 换掉「/onward 」后面的全部文字，正在写的词前面原样保留。
 *
 * 选中的词后面还能接着写时补一个空格，下一下 Tab 补下一层；`字段=` 停在 = 后面写值。写了 --help 就结束了，
 * 什么都不再给。写完的词不给列表，回车直接执行；写过的字段和引号里的值不补。
 */
export function completeArguments(prefix: string): { value: string; label: string }[] | null {
	const { words, start } = scan(prefix);
	const current = prefix.slice(start);
	if (current.includes('"')) return null;
	const head = prefix.slice(0, start);
	const done = current ? words.slice(0, -1) : words;
	const all = candidates(done, current);
	// 说明写进 label，不另给 description：pi 的参数补全把名字列固定留 32 格，说明会隔开一大截。
	// 列宽按这一层的全部候选算，不按过滤后的：边打字边过滤时说明不左右跳。
	const labels = columns(all.map((item): [string, string] => [item.value, item.description]));
	const shown = all.flatMap((item, index) =>
		item.value.startsWith(current) ? [{ item, label: labels[index]! }] : [],
	);
	if (!shown.length || shown.some(({ item }) => item.value === current)) return null;
	const spaced = (item: Candidate) => !item.value.endsWith("=") && candidates([...done, item.value], "").length > 0;
	return shown.map(({ item, label }) => ({
		value: `${head}${item.value}${spaced(item) ? " " : ""}`,
		label,
	}));
}

/**
 * `words` 后面能写的词；--help 之后、写错了的地方都是空的。--scope 只在动作前给：写在别处执行时会被拒绝；写了它之后
 * 只给能写 --scope 的动作。`--scope=<值>` 和 `--scope <值>` 一样看。
 */
function candidates(typed: string[], current: string): Candidate[] {
	if (typed.includes(HELP)) return [];
	const words = typed.flatMap((word) => {
		const option = scopeOption(word);
		return option ? [SCOPE, ...(option.inline ? [option.value ?? ""] : [])] : [word];
	});
	const at = words.indexOf(SCOPE);
	if (at > 0) return [];
	if (at === 0 && words.length === 1)
		return [
			{ value: "global", description: "全局设置；改设置时不写 --scope 就是它" },
			{ value: "project", description: "当前目录的项目级设置" },
		];
	const scoped = at === 0;
	if (scoped && scopeNamed(words[1]) === undefined) return [];
	const [first, ...rest] = scoped ? words.slice(2) : words;
	if (first === undefined)
		return [
			...(scoped ? [] : [{ value: SCOPE, description: "看或改哪一份设置，写在动作前：global 或 project" }]),
			...ACTIONS.filter((item) => !scoped || item.scoped).map((item) => ({
				value: item.name,
				description: item.description,
			})),
			{ value: HELP, description: "显示帮助" },
		];
	const spec = actionNamed(first);
	if (!spec || (scoped && !spec.scoped)) return [];
	const args = argumentCandidates(spec.name, rest, current);
	return args ? [...args, { value: HELP, description: `显示 ${spec.name} 的帮助，不执行` }] : [];
}

/** 动作后面的参数；`undefined`：这里已经写错了，执行时会被拒绝，--help 也不给。 */
function argumentCandidates(action: string, rest: string[], current: string): Candidate[] | undefined {
	switch (action) {
		case "show":
			if (!rest.length) return [{ value: "rules", description: "只看规则" }];
			return rest.length === 1 && rest[0] === "rules" ? [] : undefined;
		case "set":
		case "unset":
			return fieldCandidates(action, rest, current);
		default:
			return rest.length ? undefined : [];
	}
}

function fieldCandidates(action: string, rest: string[], current: string): Candidate[] | undefined {
	// 前面有执行时会被拒绝的词（不认识的字段、大小写不对的、没写 = 或值的），什么都不给。
	const valid = (word: string) => {
		if (action === "unset") return word === "enabled" || fieldNamed(word) !== undefined;
		const equals = word.indexOf("=");
		return equals > 0 && equals < word.length - 1 && fieldNamed(word.slice(0, equals)) !== undefined;
	};
	if (!rest.every(valid)) return undefined;
	// 写过的字段不再给：再写一次，执行时会被拒绝。
	const written = new Set(rest.map((word) => fieldNamed(word.split("=")[0])?.name));
	const unwritten = FIELDS.filter((item) => !written.has(item.name));
	if (action === "unset") {
		const toggle = rest.includes("enabled") ? [] : [{ value: "enabled", description: "开关：去掉之后继承下一层" }];
		return [...toggle, ...unwritten.map((item) => ({ value: item.name, description: item.description }))];
	}
	const equals = current.indexOf("=");
	if (equals < 0)
		return unwritten.map((item) => ({ value: `${item.name}=`, description: `${item.syntax}：${item.description}` }));
	const known = fieldNamed(current.slice(0, equals));
	if (!known || written.has(known.name)) return undefined;
	return (known.choices ?? []).map((choice) => ({
		value: `${known.name}=${choice.value}`,
		description: choice.description,
	}));
}
