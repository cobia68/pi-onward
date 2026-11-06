/** 修改默认写全局，查询默认看合并结果；set 先全部校验，--help 不执行修改。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LIMITS, FIELD_NAMES, FIELDS, type Field, fieldNamed } from "../policy/policy.ts";
import type { Recovery } from "../runtime/recovery.ts";
import { COMMAND_KEYS, SCOPES, type Scope, type Settings, type SettingsChange } from "./settings.ts";
import {
	actionsNotice,
	COMMAND,
	changedNotice,
	columns,
	commandErrorNotice,
	info,
	layerMenuText,
	layerNotice,
	menuTitle,
	type Notice,
	reloadNotice,
	rulesNotice,
	SCOPE,
	say,
	section,
	showNotice,
	statusNotice,
	table,
	toggleNotice,
} from "./text.ts";

export type Command =
	| { kind: "choose"; scope?: Scope }
	| { kind: "status" | "reload" | "actions" }
	| { kind: "reset"; scope: Scope }
	| { kind: "help"; topic?: string }
	| { kind: "show"; rules: boolean; scope?: Scope }
	| { kind: "update"; scope: Scope; change: SettingsChange }
	| { kind: "error"; message: string; topic?: string };

const HELP = "--help";
const QUIET = "quietStartup";
const QUIET_HELP: [string, string] = [
	QUIET,
	[
		"启动时的提示（用上了项目级设置、没有可用的规则）；设置有问题时照样警告。只能写在全局设置",
		"true：不显示",
		"false：照常显示，不管 pi 的 quietStartup",
		"不写：跟着 pi 的 quietStartup（默认）",
	].join("\n"),
];

const SCOPE_HELP = `${SCOPE} 写在动作前：不写或 global 改全局设置，project 改 Pi 已信任的当前项目设置；两份在哪见 /${COMMAND} show`;
const SCOPE_FALLBACK = "去掉之后继承下一层：项目级的退回全局，全局的退回内置默认值";

interface ActionSpec {
	name: string;
	args: string;
	description: string;
	details: readonly string[];
	/** 是否在帮助中列出配置字段。 */
	fields?: boolean;
	/** 是否允许 --scope；区分读配置与写配置。 */
	scoped?: "write" | "read";
	examples?: readonly string[];
}

/** 命令、帮助、菜单与补全共用的动作定义。 */
const ACTIONS: readonly ActionSpec[] = [
	{
		name: "actions",
		args: "",
		description: "查看已加载的恢复动作",
		details: ["列出动作名称、执行阶段、支持的运行模式和说明", "注册失败的动作另列诊断；未引用的坏动作不阻断当前配置"],
	},
	{
		name: "status",
		args: "",
		description: "查看当前状态",
		details: [
			"显示自动续跑开关和当前运行状态；待命时显示可用规则数，没有续跑记录时不显示零计数",
			"显示连续失败次数、已启动续跑次数、当前恢复阶段和动作结果",
			"从第几次失败进入哪个阶段由 rules[].stages 决定，规则切换不清零",
			"超过 maxFailures 停止；原生接管受 maxHandoffs 限制",
			`默认参数、规则详情和设置文件位置见 /${COMMAND} show`,
			`配置有问题时只显示原因摘要，详情用 /${COMMAND} show；停止时显示原因和处理提示`,
		],
	},
	{
		name: "on",
		args: "",
		description: "启用自动续跑",
		details: [
			"在设置文件里写 enabled: true",
			"成功后只确认启用结果和配置范围；当前仍不能续跑时补充原因",
			`设置文件有问题时打开了也不续跑：先改好，再 /${COMMAND} reload`,
			"启用开关会取消当前恢复并清零，不立即发起恢复",
			"保存失败时明确提示；本次运行保留配置修改，重新加载或重启后以原文件为准",
		],
		scoped: "write",
	},
	{
		name: "off",
		args: "",
		description: "停用自动续跑",
		details: [
			"在设置文件里写 enabled: false",
			"成功后只确认停用结果和配置范围；项目级仍启用时说明覆盖关系",
			"成功修改配置会取消等待、待执行动作并清零计数",
			"保存失败时明确提示；本次运行保留配置修改，重新加载或重启后以原文件为准",
		],
		scoped: "write",
	},
	{
		name: "show",
		args: "[rules]",
		description: "查看配置参数、来源和规则",
		details: [
			"查看当前已加载的配置：开关与启动提示、恢复上限、规则及来源、配置文件位置",
			"参数标明来源及未保存的字段；项目级 rules 整份替换全局规则，不拼接",
			"show rules 只显示规则；按顺序列出，第一条命中的生效，停用的标出来",
			"配置无效时只列具体问题和文件位置，不展示部分参数或规则",
			`写了 ${SCOPE} 时只看本层显式配置，不合并、不填默认值；未写 rules 与显式空列表不同`,
			`手改文件后 /${COMMAND} reload；show 本身不重载、不写配置`,
		],
		scoped: "read",
		examples: [`/${COMMAND} show rules`, `/${COMMAND} ${SCOPE} project show`],
	},
	{
		name: "set",
		args: "字段=值 …",
		description: "修改配置参数",
		details: [
			"可以一次写几个：先全部检查，有一项不合法就一项都不改，问题一起说",
			"成功后只回显本次修改值和目标范围；项目级覆盖与当前不可用原因另行说明",
			"修改恢复过程的上限、动作执行时限和全局 quietStartup",
			"写入失败时本次运行保留配置修改，重新加载或重启后以原文件为准",
			"修改配置会取消当前恢复过程",
			`rules 只能在设置文件里手写，改完 /${COMMAND} reload；开关用 /${COMMAND} on、off`,
		],
		fields: true,
		scoped: "write",
		examples: [
			`/${COMMAND} set maxFailures=20 actionTimeout=30s`,
			`/${COMMAND} set maxHandoffs=2`,
			`/${COMMAND} ${SCOPE} project set maxFailures=3`,
		],
	},
	{
		name: "unset",
		args: "字段 …",
		description: "移除指定配置项",
		details: [
			"可以一次写几个，开关 enabled、启动提示 quietStartup 也能去掉；有不认识或写了两次的字段就一项都不改",
			"规则中的阶段与动作不受影响",
			"成功后说明移除后当前采用的值和来源；配置无效时不展示继承值",
			"写入失败时本次运行保留配置修改，重新加载或重启后以原文件为准",
			SCOPE_FALLBACK,
		],
		fields: true,
		scoped: "write",
		examples: [`/${COMMAND} unset maxFailures actionTimeout`, `/${COMMAND} ${SCOPE} project unset enabled`],
	},
	{
		name: "reload",
		args: "",
		description: "重新加载配置",
		details: [
			"丢弃未保存修改，重读配置；项目级仅在绑定且受信任时读取，会话开始前只读全局",
			`成功时确认读取范围；配置无效时说明原因摘要，详情见 /${COMMAND} show`,
			"重载会取消等待、待执行动作和本轮计数，不主动发起恢复",
		],
	},
	{
		name: "reset",
		args: "",
		description: "重置配置参数，保留规则",
		details: [
			"开关、参数和 quietStartup 都去掉；rules 和其他手写的内容留着",
			"反馈确认重置范围和保留内容，不把重置某一层说成整个项目恢复内置默认值",
			"正在等的续跑立刻打断，运行状态和计数清零；即使目标配置无法读取或保存也一样",
			"写入失败时本次运行保留配置修改，重新加载或重启后以原文件为准",
			SCOPE_FALLBACK,
		],
		scoped: "write",
	},
];

const DESCRIPTION = "控制自动续跑，查看状态和配置";

export function registerCommand(pi: ExtensionAPI, settings: Settings, onward: Recovery): void {
	pi.registerCommand(COMMAND, {
		description: DESCRIPTION,
		getArgumentCompletions: (prefix) => completeArguments(prefix),
		handler: async (args, ctx) => {
			if (args.startsWith("_dispatch ")) {
				await onward.dispatch(args.slice(10), ctx);
				return;
			}
			let command = parseCommand(args);
			// 选中作用域后继续进入该层菜单。
			while (command.kind === "choose") {
				const picked = await choose(ctx, settings, onward, command.scope);
				if (picked === undefined) return;
				command = parseCommand(picked);
			}
			const notice = execute(command, settings, onward, ctx);
			say(ctx, notice);
		},
	});
}

/** 必填参数的动作只填入编辑器；其余返回可执行命令。 */
async function choose(
	ctx: ExtensionContext,
	settings: Settings,
	onward: Recovery,
	scope?: Scope,
): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const items = menuItems(scope);
	const label = await ctx.ui.select(
		menuTitle(settings, scope, onward.status().state),
		items.map((item) => item.label),
	);
	const picked = items.find((item) => item.label === label);
	if (!picked?.fill) return picked?.input;
	ctx.ui.setEditorText(`/${COMMAND} ${picked.input} `);
	return undefined;
}

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
	onward: Recovery,
	ctx: ExtensionContext,
): Notice {
	// Read-only queries never change the recovery state.
	const status = () => onward.status();
	switch (command.kind) {
		case "actions":
			return actionsNotice(onward.registry.list(), onward.registry.diagnostics);
		case "status":
			return statusNotice(settings, status());
		case "help":
			return info(helpText(command.topic));
		case "error":
			return commandErrorNotice(command.message, command.topic);
		case "show":
			if (command.scope) return layerNotice(settings, command.scope, command.rules);
			return command.rules ? rulesNotice(settings) : showNotice(settings);
		case "reload":
			settings.reload();
			onward.stop(ctx);
			return reloadNotice(settings, status());
		case "reset": {
			const saved = settings.reset(command.scope);
			onward.stop(ctx);
			return changedNotice(saved, settings, status(), { action: "reset", scope: command.scope, keys: COMMAND_KEYS });
		}
		case "update": {
			const saved = settings.update(command.scope, command.change);
			if (saved.kind === "saved" || saved.kind === "unwritten") onward.stop(ctx);
			if (command.change.enabled !== undefined)
				return toggleNotice(saved, settings, status(), command.scope, command.change.enabled);
			return changedNotice(saved, settings, status(), {
				action: command.change.unset ? "unset" : "set",
				scope: command.scope,
				keys: command.change.unset ?? Object.keys(command.change.set ?? {}),
			});
		}
	}
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
	if (count > 1) return { kind: "error", message: `${SCOPE} may only be specified once`, ...topic };
	const scope = count ? scopeNamed(value) : "global";
	// 先看 --scope 的值：`--scope set …` 是漏写了值，不是动作写错了。
	if (scope === undefined)
		return {
			kind: "error",
			message: `${SCOPE} ${value === undefined ? "requires" : "must be"} ${SCOPES.join(" or ")}`,
			...topic,
		};
	if (first !== undefined && !spec) return unknownAction(first);
	if (count && spec && !spec.scoped) return { kind: "error", message: scopedOnly(), topic: spec.name };
	if (count && at !== 0)
		return {
			kind: "error",
			message: `${SCOPE} must precede the action: /${COMMAND} ${[SCOPE, scope, ...words.map(quoted)].join(" ")}`,
			...topic,
		};
	if (!spec) return count ? { kind: "choose", scope } : { kind: "choose" };
	const action = spec.name;
	switch (action) {
		case "status":
		case "reload":
		case "actions":
			return none(action, rest) ?? { kind: action };
		case "reset":
			return none(action, rest) ?? { kind: "reset", scope };
		case "on":
		case "off":
			return none(action, rest) ?? { kind: "update", scope, change: { enabled: action === "on" } };
		case "show": {
			const only = count ? { scope } : {};
			if (!rest.length) return { kind: "show", rules: false, ...only };
			if (rest.length === 1 && rest[0] === "rules") return { kind: "show", rules: true, ...only };
			return { kind: "error", message: "show only accepts the optional argument 'rules'", topic: "show" };
		}
		case "set":
			return parseSet(rest, scope);
		case "unset":
			return parseUnset(rest, scope);
		default:
			return unknownAction(first!);
	}
}

/** at 是首个 --scope 前的其他词数；只有 0 合法。支持 --scope=x 与 --scope x。 */
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

/** inline 区分 --scope 与 --scope=（包括空值）。 */
function scopeOption(token: string): { inline: boolean; value?: string } | undefined {
	const match = /^--scope(?:=(.*))?$/.exec(token);
	if (!match) return undefined;
	return match[1] === undefined ? { inline: false } : { inline: true, value: match[1] };
}

function scopeNamed(value: string | undefined): Scope | undefined {
	return SCOPES.find((scope) => scope === value);
}

function quoted(word: string): string {
	if (!/\s/.test(word)) return word;
	const equals = word.indexOf("=");
	return equals > 0 ? `${word.slice(0, equals + 1)}"${word.slice(equals + 1)}"` : `"${word}"`;
}

function scopedOnly(): string {
	return `${SCOPE} is only supported by ${scopedActions()}`;
}

function scopedActions(only?: "write"): string {
	return ACTIONS.filter((item) => (only ? item.scoped === only : item.scoped))
		.map((item) => item.name)
		.join(", ");
}

function unknownAction(word: string): Command {
	return { kind: "error", message: `Unknown action '${word}'; available actions: ${actionList()}` };
}

/** 拒绝无参动作后多写的参数。 */
function none(action: string, rest: string[]): Command | undefined {
	return rest.length ? { kind: "error", message: `${action} does not accept arguments`, topic: action } : undefined;
}

function parseSet(tokens: string[], scope: Scope): Command {
	if (!tokens.length)
		return {
			kind: "error",
			message: `set requires field=value; available fields: ${settable(scope).join(", ")}`,
			topic: "set",
		};
	const problems: string[] = [];
	const values: Record<string, unknown> = {};
	for (const token of tokens) {
		const equals = token.indexOf("=");
		if (equals <= 0) {
			problems.push(`'${token}' must use field=value`);
			continue;
		}
		const key = token.slice(0, equals);
		const text = token.slice(equals + 1);
		if (Object.hasOwn(values, key)) {
			problems.push(`${key} may only be specified once`);
			continue;
		}
		const parsed = key === QUIET ? quietValue(text, scope) : paramValue(key, text, scope);
		if ("problem" in parsed) problems.push(parsed.problem);
		else values[parsed.name] = parsed.value;
	}
	return problems.length ? rejected(problems, "set") : { kind: "update", scope, change: { set: values } };
}

type Parsed = { name: string; value: unknown } | { problem: string };

function paramValue(key: string, text: string, scope: Scope): Parsed {
	const known = paramField(key, scope, settable(scope));
	if (typeof known === "string") return { problem: known };
	const value = known.fromText(text);
	const read = known.read(value);
	return "problem" in read ? { problem: `${known.name} ${read.problem}` } : { name: known.name, value };
}

/** 项目不能自行隐藏启用项目配置的提示。 */
function quietValue(text: string, scope: Scope): Parsed {
	if (scope !== "global")
		return { problem: `${QUIET} is only allowed in global settings; omit ${SCOPE} to use global scope` };
	if (text !== "true" && text !== "false") return { problem: `${QUIET} must be true or false` };
	return { name: QUIET, value: text === "true" };
}

function settable(scope: Scope): readonly string[] {
	return scope === "global" ? [...FIELD_NAMES, QUIET] : FIELD_NAMES;
}

function parseUnset(tokens: string[], scope: Scope): Command {
	if (!tokens.length)
		return {
			kind: "error",
			message: `unset requires field names; available fields: ${COMMAND_KEYS.join(", ")}`,
			topic: "unset",
		};
	const problems: string[] = [];
	const unset: string[] = [];
	for (const token of tokens) {
		const key = unsetKey(token, scope);
		if ("problem" in key) problems.push(key.problem);
		else if (unset.includes(key.name)) problems.push(`${key.name} may only be specified once`);
		else unset.push(key.name);
	}
	return problems.length ? rejected(problems, "unset") : { kind: "update", scope, change: { unset } };
}

function unsetKey(token: string, scope: Scope): { name: string } | { problem: string } {
	// 允许删除项目层误写的 quietStartup，以修复配置。
	if (token === "enabled" || token === QUIET) return { name: token };
	const known = paramField(token, scope, COMMAND_KEYS);
	return typeof known === "string" ? { problem: known } : { name: known.name };
}

function paramField(key: string, scope: Scope, names: readonly string[] = FIELD_NAMES): Field | string {
	if (key === "rules") return `rules must be edited in the settings file; then run /${COMMAND} reload`;
	if (key === "enabled")
		return `use /${COMMAND} ${scope === "project" ? `${SCOPE} project ` : ""}on or off to change enabled`;
	return fieldNamed(key) ?? `Unknown field '${key}'; available fields: ${names.join(", ")}`;
}

function rejected(problems: string[], topic: string): Command {
	return { kind: "error", message: `${problems.join("; ")}. No changes made`, topic };
}

function actionList(): string {
	return ACTIONS.map((item) => item.name).join(", ");
}

function actionNamed(name: string): ActionSpec | undefined {
	return ACTIONS.find((item) => item.name === name);
}

// ── 帮助 ──

export function helpText(topic?: string): string {
	const spec = topic === undefined ? undefined : actionNamed(topic);
	return spec ? actionHelp(spec) : overallHelp();
}

function overallHelp(): string {
	return [
		`${COMMAND} — ${DESCRIPTION}`,
		`用法：/${COMMAND} [${SCOPE} <${SCOPES.join("|")}>] [动作] [参数] [${HELP}]`,
		...section("动作", table(ACTIONS.map((item) => [item.name, item.description]))),
		"",
		`  不写动作时弹出菜单，标题区分当前状态和修改目标；菜单里的 ${SCOPE} <层> … 进到只看、只改那一份的菜单`,
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
		...(spec.fields
			? section(
					"字段",
					table([
						...(spec.name === "unset" ? [["enabled", "自动续跑开关；去掉后继承下一层"] as [string, string]] : []),
						...FIELDS.map((item): [string, string] => [item.name, fieldHelp(item)]),
						QUIET_HELP,
					]),
				)
			: []),
		...section(
			"示例",
			(spec.examples ?? []).map((line) => `  ${line}`),
		),
	].join("\n");
}

function usage(spec: ActionSpec): string {
	const words = [spec.scoped ? `[${SCOPE} <${SCOPES.join("|")}>]` : "", spec.name, spec.args];
	return words.filter(Boolean).join(" ");
}

function fieldHelp(item: Field): string {
	return [item.description, `${item.syntax}；默认：${item.show(DEFAULT_LIMITS[item.name])}`].join("\n");
}

// ── 分词 ──

/** 与补全共用分词，未闭合引号只在执行时拒绝。 */
function tokenize(text: string): string[] | string {
	const { words, quoted } = scan(text);
	return quoted ? "Unmatched double quote" : words;
}

/** start 为当前词的起点；quoted 表示引号未闭合，补全时允许这种中间状态。 */
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

/** value 替换 /onward 后的全部参数；保留已输入前缀，仅补全当前词。 */
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
			...(scoped ? [] : [{ value: SCOPE, description: "指定查看或修改的配置范围" }]),
			...ACTIONS.filter((item) => !scoped || item.scoped).map((item) => ({
				value: item.name,
				description: item.description,
			})),
			{ value: HELP, description: "显示帮助" },
		];
	const spec = actionNamed(first);
	if (!spec || (scoped && !spec.scoped)) return [];
	const args = argumentCandidates(spec.name, rest, current, scoped ? scopeNamed(words[1])! : "global");
	return args ? [...args, { value: HELP, description: `显示 ${spec.name} 的帮助，不执行` }] : [];
}

/** undefined 表示输入已无效，不再补全 --help。 */
function argumentCandidates(action: string, rest: string[], current: string, scope: Scope): Candidate[] | undefined {
	switch (action) {
		case "show":
			if (!rest.length) return [{ value: "rules", description: "只看规则" }];
			return rest.length === 1 && rest[0] === "rules" ? [] : undefined;
		case "set":
		case "unset":
			return fieldCandidates(action, rest, current, scope);
		default:
			return rest.length ? undefined : [];
	}
}

const QUIET_CHOICES: readonly Candidate[] = [
	{ value: "true", description: "启动时不显示 onward 的提示；设置有问题时照样警告" },
	{ value: "false", description: "照常显示，不管 pi 的 quietStartup" },
];

function fieldCandidates(action: string, rest: string[], current: string, scope: Scope): Candidate[] | undefined {
	// 项目层不提示 quietStartup，但允许手写 unset 来修复误配置。
	const offered = scope === "global";
	const named = (name: string) =>
		fieldNamed(name) !== undefined || (name === QUIET && (offered || action === "unset"));
	const valid = (word: string) => {
		if (action === "unset") return word === "enabled" || named(word);
		const equals = word.indexOf("=");
		return equals > 0 && equals < word.length - 1 && named(word.slice(0, equals));
	};
	if (!rest.every(valid)) return undefined;
	const written = new Set(rest.map((word) => word.split("=")[0]));
	const unwritten = FIELDS.filter((item) => !written.has(item.name));
	const quiet = offered && !written.has(QUIET);
	if (action === "unset") {
		const toggle = written.has("enabled") ? [] : [{ value: "enabled", description: "开关：去掉之后继承下一层" }];
		return [
			...toggle,
			...unwritten.map((item) => ({ value: item.name, description: item.description })),
			...(quiet ? [{ value: QUIET, description: "启动提示：去掉之后跟着 pi 的 quietStartup" }] : []),
		];
	}
	const equals = current.indexOf("=");
	if (equals < 0)
		return [
			...unwritten.map((item) => ({ value: `${item.name}=`, description: `${item.syntax}：${item.description}` })),
			...(quiet ? [{ value: `${QUIET}=`, description: "true 或 false：启动时的提示显示不显示" }] : []),
		];
	const name = current.slice(0, equals);
	if (written.has(name)) return undefined;
	if (name === QUIET)
		return quiet ? QUIET_CHOICES.map((choice) => ({ ...choice, value: `${QUIET}=${choice.value}` })) : undefined;
	return fieldNamed(name) ? [] : undefined;
}
