/**
 * `/onward <动作> [参数]`：动作在前，参数写成 `字段=值`，字段名和设置文件一样。`set` 全有或全无：任何一项
 * 不合法就一项都不写。不写动作时弹出菜单，标题是现在的状态。
 *
 * `--help` 是结束：写在哪都只显示帮助、不执行，跟在动作后面时显示这个动作的帮助。补全在每个动作后面都给它，
 * 写了它之后什么都不再给，后面有没有空格都一样。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isActive } from "../policy/config.ts";
import { DEFAULT_POLICY, FIELD_NAMES, FIELDS, type Field, fieldNamed } from "../policy/policy.ts";
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
	section,
	showNotice,
	statusHeadline,
	statusNotice,
	table,
} from "./text.ts";

/** `topic`：帮助或出错是关于哪个动作的，没有时是总帮助。`choose`：没写动作，弹菜单。 */
export type Command =
	| { kind: "choose" }
	| { kind: "status" | "reload" | "reset" }
	| { kind: "help"; topic?: string }
	| { kind: "show"; rules: boolean }
	| { kind: "update"; change: SettingsChange }
	| { kind: "error"; message: string; topic?: string };

const HELP = "--help";

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
			"下面是规则没写的参数（做法、上限、间隔）和设置文件在哪",
			`设置文件有问题时只说有几处，详情用 /${COMMAND} show`,
		],
	},
	{
		name: "on",
		args: "",
		description: "打开",
		details: ["在设置文件里写 enabled: true", `设置文件有问题时打开了也不续跑：先改好，再 /${COMMAND} reload`],
	},
	{
		name: "off",
		args: "",
		description: "关掉",
		details: ["在设置文件里写 enabled: false", "正在等的续跑立刻打断，计数清零"],
	},
	{
		name: "show",
		args: "[rules]",
		description: "各项参数和来源、规则、设置文件里的问题；rules 只看规则",
		details: [
			"每个参数的值，以及它来自设置文件还是内置默认值",
			"规则按顺序列出，第一条命中的生效；停用的标出来",
			"设置文件有问题时不列规则，只列问题",
		],
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
		examples: [
			`/${COMMAND} set action=resend maxRetries=20 delay=5s,10s,30s`,
			`/${COMMAND} set prompt="接着做 {error}"`,
		],
	},
	{
		name: "unset",
		args: "字段 …",
		description: "去掉参数，退回内置默认值",
		details: ["可以一次写几个；有不认识或写了两次的字段就一项都不改", "规则里写的同名字段不受影响"],
		fields: true,
		examples: [`/${COMMAND} unset delay maxRetries`],
	},
	{
		name: "reload",
		args: "",
		description: "重新读设置文件（手改 rules 之后用）",
		details: ["读完显示和 status 一样的状态", "读到关着或有问题的设置时，正在等的续跑立刻打断"],
	},
	{
		name: "reset",
		args: "",
		description: "去掉开关和参数，保留手写的 rules",
		details: ["开关回到打开，参数回到内置默认值；rules 和其他手写的内容留着", "正在等的续跑立刻打断，计数清零"],
	},
];

const DESCRIPTION = `出错后按规则自动续跑（不写动作时弹出菜单，${HELP} 查看用法）`;

export function registerCommand(pi: ExtensionAPI, settings: Settings, onward: Onward): void {
	pi.registerCommand(COMMAND, {
		description: DESCRIPTION,
		getArgumentCompletions: (prefix) => completeArguments(prefix),
		handler: async (args, ctx) => {
			let command = parseCommand(args);
			if (command.kind === "choose") {
				const picked = await choose(ctx, settings);
				if (picked === undefined) return;
				command = parseCommand(picked);
			}
			if (command.kind === "choose") return;
			const notice = execute(command, settings, onward, ctx);
			// 不管是命令关的、还是 reload 读到手改的关或有问题的设置，不生效了就不该还有等着的续跑。
			if (!isActive(settings.config)) onward.stop(ctx);
			say(ctx, notice);
		},
	});
}

/**
 * `/onward` 不写动作：弹出菜单，标题是现在的状态。返回选中的动作；要写参数的（set、unset）填进输入框接着写，
 * 返回 undefined。没有界面时不弹，什么都不做。
 */
async function choose(ctx: ExtensionContext, settings: Settings): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const items = menuItems();
	const label = await ctx.ui.select(
		statusHeadline(settings),
		items.map((item) => item.label),
	);
	const picked = items.find((item) => item.label === label);
	if (!picked?.fill) return picked?.input;
	ctx.ui.setEditorText(`/${COMMAND} ${picked.input} `);
	return undefined;
}

/** 每个动作一项，最后是 --help；和帮助里的动作表同一个写法。`fill`：参数非写不可。 */
export function menuItems(): { label: string; input: string; fill: boolean }[] {
	const labels = table(
		[...ACTIONS.map((item): [string, string] => [usage(item), item.description]), [HELP, "显示帮助"]],
		0,
	);
	return [
		...ACTIONS.map((item, index) => ({
			label: labels[index]!,
			input: item.name,
			fill: item.args !== "" && !item.args.startsWith("["),
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
			return command.rules ? rulesNotice(settings) : showNotice(settings);
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
				kept ? "已恢复默认，手写的 rules 保留" : "已恢复默认",
			);
		}
		case "update":
			return changedNotice(settings.update(command.change), settings, onward.progress());
	}
}

export function parseCommand(text: string): Command {
	const tokens = tokenize(text);
	if (typeof tokens === "string") return { kind: "error", message: tokens };
	if (tokens.includes(HELP)) {
		const [first] = tokens.filter((token) => token !== HELP);
		if (first === undefined) return { kind: "help" };
		const spec = actionNamed(first);
		return spec ? { kind: "help", topic: spec.name } : unknownAction(first);
	}
	const [first, ...rest] = tokens;
	if (first === undefined) return { kind: "choose" };
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
			if (rest.length === 1 && rest[0].toLowerCase() === "rules") return { kind: "show", rules: true };
			return { kind: "error", message: "show 后面只能写 rules", topic: "show" };
		case "set":
			return parseSet(rest);
		case "unset":
			return parseUnset(rest);
		default:
			return unknownAction(first);
	}
}

function unknownAction(word: string): Command {
	return { kind: "error", message: `不认识的动作 ${word}；可用 ${actionList()}` };
}

/** 不带参数的动作带了参数。 */
function none(action: string, rest: string[]): Command | undefined {
	return rest.length ? { kind: "error", message: `${action} 不带参数`, topic: action } : undefined;
}

function parseSet(tokens: string[]): Command {
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
	return problems.length ? rejected(problems, "set") : { kind: "update", change: { set: values } };
}

function parseUnset(tokens: string[]): Command {
	if (!tokens.length)
		return { kind: "error", message: `unset 要写字段名；可用 ${FIELD_NAMES.join("、")}`, topic: "unset" };
	const problems: string[] = [];
	const unset: string[] = [];
	for (const token of tokens) {
		const known = paramField(token);
		if (typeof known === "string") problems.push(known);
		else if (unset.includes(known.name)) problems.push(`${known.name} 写了两次`);
		else unset.push(known.name);
	}
	return problems.length ? rejected(problems, "unset") : { kind: "update", change: { unset } };
}

/** 参数字段；不是时说明为什么。 */
function paramField(key: string): Field | string {
	const lower = key.toLowerCase();
	if (lower === "rules") return "rules 要在设置文件里手写，改完 /onward reload";
	if (lower === "enabled") return "开关用 /onward on 或 off";
	return fieldNamed(key) ?? `不认识的字段 ${key}；可用 ${FIELD_NAMES.join("、")}`;
}

function rejected(problems: string[], topic: string): Command {
	return { kind: "error", message: `${problems.join("；")}。未做任何修改`, topic };
}

function actionList(): string {
	return ACTIONS.map((item) => item.name).join("、");
}

function actionNamed(name: string): ActionSpec | undefined {
	const lower = name.toLowerCase();
	return ACTIONS.find((item) => item.name === lower);
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
		`用法：/${COMMAND} [动作] [参数] [${HELP}]`,
		...section("动作", table(ACTIONS.map((item) => [usage(item), item.description]))),
		"",
		"  不写动作时弹出菜单，标题是现在的状态",
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
			spec.details.map((line) => `  ${line}`),
		),
		...(spec.fields ? section("字段", table(FIELDS.map((item) => [item.name, fieldHelp(item)]))) : []),
		...section(
			"示例",
			(spec.examples ?? []).map((line) => `  ${line}`),
		),
	].join("\n");
}

function usage(spec: ActionSpec): string {
	return spec.args ? `${spec.name} ${spec.args}` : spec.name;
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
 * 补全：动作、show 的 rules、set 和 unset 的字段名、action 的取值，以及每个动作后面的 --help。返回的 value
 * 换掉「/onward 」后面的全部文字，正在写的词前面原样保留。
 *
 * 选中的词后面还能接着写时补一个空格，下一下 Tab 补下一层；`字段=` 停在 = 后面写值。写了 --help 就结束了，
 * 什么都不再给。写完的词不给列表，回车直接执行；写过的字段和引号里的值不补。
 */
export function completeArguments(prefix: string): { value: string; label: string; description: string }[] | null {
	const { words, start } = scan(prefix);
	const current = prefix.slice(start);
	if (current.includes('"')) return null;
	const head = prefix.slice(0, start);
	const done = current ? words.slice(0, -1) : words;
	const shown = candidates(done, current).filter((item) => item.value.toLowerCase().startsWith(current.toLowerCase()));
	if (!shown.length || shown.some((item) => item.value.toLowerCase() === current.toLowerCase())) return null;
	const spaced = (item: Candidate) => !item.value.endsWith("=") && candidates([...done, item.value], "").length > 0;
	return shown.map((item) => ({
		value: `${head}${item.value}${spaced(item) ? " " : ""}`,
		label: item.value,
		description: item.description,
	}));
}

/** `words` 后面能写的词；--help 之后、写错了的地方都是空的。 */
function candidates(words: string[], current: string): Candidate[] {
	if (words.includes(HELP)) return [];
	const [first, ...rest] = words;
	if (first === undefined)
		return [
			...ACTIONS.map((item) => ({ value: item.name, description: item.description })),
			{ value: HELP, description: "显示帮助" },
		];
	const spec = actionNamed(first);
	const args = spec && argumentCandidates(spec.name, rest, current);
	return args ? [...args, { value: HELP, description: `显示 ${spec.name} 的帮助，不执行` }] : [];
}

/** 动作后面的参数；`undefined`：这里已经写错了，执行时会被拒绝，--help 也不给。 */
function argumentCandidates(action: string, rest: string[], current: string): Candidate[] | undefined {
	switch (action) {
		case "show":
			if (!rest.length) return [{ value: "rules", description: "只看规则" }];
			return rest.length === 1 && rest[0].toLowerCase() === "rules" ? [] : undefined;
		case "set":
		case "unset":
			return fieldCandidates(action, rest, current);
		default:
			return rest.length ? undefined : [];
	}
}

function fieldCandidates(action: string, rest: string[], current: string): Candidate[] | undefined {
	// 写过的字段不再给：再写一次，执行时会被拒绝。
	const written = new Set(rest.map((word) => fieldNamed(word.split("=")[0])?.name));
	const unwritten = FIELDS.filter((item) => !written.has(item.name));
	if (action === "unset") return unwritten.map((item) => ({ value: item.name, description: item.description }));
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
