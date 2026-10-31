/**
 * 给用户看的通知、状态栏和设置说明；命令的用法在 command.ts，和命令的写法放在一起。
 *
 * pi 把 info 通知画成暗色、warning 画成黄色并加上「Warning:」，所以颜色只分轻重；状态靠开头的图标看：
 * ⏩ 在管（开着、有规则，或正在续跑），💤 不会续跑（关了、没有规则），🛑 停了或要先修。三个图标都占两格，
 * 后面的字始终在同一列。
 *
 * 续跑和停手时状态栏写状态（图标、第几次、哪条规则）；会话里的提示只补状态栏没有的：续跑说接下来做什么，
 * 停手说为什么、怎么办，不重复图标、次数和规则名。错误本身 pi 已经在上面用红字显示，提示里也不再摘。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config, Hit } from "../policy/config.ts";
import { formatDelay, retryDelay, totalDelay } from "../policy/delay.ts";
import { EMPTY_REPLY, errorSignature, type Failure } from "../policy/failure.ts";
import { DEFAULT_POLICY, FIELDS, type Field, type Policy, type PolicyPatch, resolvePolicy } from "../policy/policy.ts";
import type { Rule } from "../policy/rules.ts";
import type { GiveUp, Progress, Retry } from "../policy/tracker.ts";
import { isRecord } from "../util.ts";
import type { Continue } from "./onward.ts";
import type { Saved, Scope, Settings, SettingsFile } from "./settings.ts";

export const COMMAND = "onward";
/** 改设置的命令改哪一份：写在动作前，`--scope project <动作>`；不写就是全局。 */
export const SCOPE = "--scope";

export interface Notice {
	message: string;
	level: "info" | "warning";
}

/** 没有界面时（`pi -p`）不提示；RPC 下 pi 把它发给客户端，显不显示由客户端定。 */
export function say(ctx: Pick<ExtensionContext, "hasUI" | "ui">, notice: Notice): void {
	if (ctx.hasUI) ctx.ui.notify(notice.message, notice.level);
}

export const info = (message: string): Notice => ({ message, level: "info" });
const warning = (message: string): Notice => ({ message, level: "warning" });

const RUNNING = "⏩";
const IDLE = "💤";
const STOPPED = "🛑";

const UNTIL_FIXED = "修好之前不会自动续跑";
const addRules = (where = "设置文件") => `在${where}的 rules 里写规则（常见规则见 README），再 /${COMMAND} reload`;

/** 两份设置文件给人看的名字：表格、来源和问题前面都用它。 */
const SCOPE_NAMES: Readonly<Record<Scope, string>> = { global: "全局", project: "项目级" };

// ── 排版 ──

/** 帮助和状态里的表：行首空两格，名字一列、内容一列，按终端里的宽度对齐；内容的后几行对齐在第一行下面。 */
export function table(rows: [name: string, text: string][]): string[] {
	const width = Math.max(0, ...rows.map(([name]) => cells(name)));
	return rows.flatMap(([name, text]) => {
		const [first, ...more] = text.split("\n");
		return [
			`  ${name}${" ".repeat(width - cells(name))}  ${first}`,
			...more.map((line) => `  ${" ".repeat(width)}  ${line}`),
		];
	});
}

/**
 * 菜单和补全的每一项：名字一列、说明一列，按终端里的宽度对齐。说明里的换行换成空格，所以一项正好一行，
 * 返回的第几行就是第几项，调用方按下标取回。
 */
export function columns(rows: [name: string, text: string][]): string[] {
	const width = Math.max(0, ...rows.map(([name]) => cells(name)));
	return rows.map(([name, text]) => `${name}${" ".repeat(width - cells(name))}  ${text.replace(/\s*\n\s*/g, " ")}`);
}

/** 有内容才出这一节，前面空一行。 */
export function section(title: string, lines: string[]): string[] {
	return lines.length ? ["", title, ...lines] : [];
}

/** 终端里占几格：中文和全角字符占两格。 */
export function cells(text: string): number {
	return [...text].reduce(
		(sum, char) =>
			sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1),
		0,
	);
}

// ── /onward ──

/** `topic`：出错的动作，用法指到它自己的帮助。 */
export function commandErrorNotice(message: string, topic?: string): Notice {
	return warning(`onward：${message}；用法见 /${COMMAND}${topic ? ` ${topic}` : ""} --help`);
}

/** `/onward` 菜单的标题：现在的状态；写了 `--scope` 时补上这个菜单看、改的是哪一份。 */
export function menuTitle(settings: Settings, scope?: Scope): string {
	const headline = statusHeadline(settings);
	return scope ? `${headline} · ${SCOPE_NAMES[scope]}设置` : headline;
}

/** `/onward` 菜单里进到这一份的菜单的那一项的说明。 */
export function layerMenuText(scope: Scope): string {
	return `只看、只改${SCOPE_NAMES[scope]}设置`;
}

/** 一行说清现在会不会续跑：`/onward status` 的第一行，也是 `/onward` 菜单的标题。 */
export function statusHeadline(settings: Settings): string {
	const { config } = settings;
	if (brokenFiles(settings).length) return `${STOPPED} onward：设置文件读不了，${UNTIL_FIXED}`;
	const problems = config.problems.length;
	if (problems && !config.enabled) return `${STOPPED} onward：关；设置文件有 ${problems} 处问题，打开前要先修好`;
	if (problems) return `${STOPPED} onward：开，但设置文件有 ${problems} 处问题，${UNTIL_FIXED}`;
	if (!config.enabled) return `${IDLE} onward：关，出错时不会自动续跑`;
	const usable = usableRules(config);
	return usable
		? `${RUNNING} onward：开，${usable} 条规则生效`
		: `${IDLE} onward：开，但没有可用的规则，出错时不会自动续跑`;
}

export function statusNotice(settings: Settings, progress: Progress, note?: string): Notice {
	return { message: statusText(settings, progress, note), level: needsFix(settings) ? "warning" : "info" };
}

/**
 * `/onward status`：标题一行，正在续跑时下一行是进度；再是规则没写的参数和设置文件，最后一行是下一步。
 * `note` 是刚做完的事，跟在标题后面。
 */
function statusText(settings: Settings, { used, streak }: Progress, note?: string): string {
	const { config } = settings;
	const lines = [statusHeadline(settings), ...(note ? [note] : [])];
	if (used || streak) lines.push(`上次正常返回之后已续跑 ${used} 次，同一个错误连续 ${streak} 次`);
	// 读不了的文件也记成一处问题，所以这里不用另外看。
	const usable = !config.problems.length;
	if (usable) lines.push(...section("规则没写的参数", table(policyRows(resolvePolicy(config.defaults)))));
	lines.push(...section("设置文件", table(fileRows(settings.files))), "");
	if (!usable) lines.push(`改好之后 /${COMMAND} reload；问题见 /${COMMAND} show`);
	else if (!config.enabled)
		lines.push(`/${COMMAND} ${settings.origin("enabled") === "project" ? `${SCOPE} project ` : ""}on 打开`);
	else if (!usableRules(config)) lines.push(addRules());
	else lines.push(`规则见 /${COMMAND} show rules`);
	return lines.join("\n");
}

/** 每份设置文件一行：哪一份、在哪、能不能读。 */
function fileRows(files: readonly SettingsFile[]): [string, string][] {
	return files.map((file) => [SCOPE_NAMES[file.scope], fileState(file)]);
}

function fileState({ scope, path, source }: SettingsFile): string {
	switch (source.kind) {
		case "file":
			return path;
		case "none":
			return `${path}（还没有，${scope === "global" ? "改设置时自动建" : `改设置时写 ${SCOPE} project 自动建`}）`;
		case "broken":
			return `${path}\n读不了：${source.error}`;
	}
}

type BrokenFile = SettingsFile & { source: { kind: "broken" } };

function brokenFiles(settings: Settings): BrokenFile[] {
	return settings.files.filter((file): file is BrokenFile => file.source.kind === "broken");
}

/** `/onward show`：每个参数的值和它从哪来，再是规则，最后是设置文件。 */
export function showNotice(settings: Settings): Notice {
	if (brokenFiles(settings).length) return rulesNotice(settings);
	const { defaults } = settings.config;
	const rows = FIELDS.map((item): [string, string] => {
		const from = settings.origin(item.name);
		const value = (from ? defaults : DEFAULT_POLICY)[item.name] as never;
		const where = from ? `${SCOPE_NAMES[from]}设置` : "内置默认值";
		return [item.name, `${(item as Field<typeof item.name>).show(value)}（${where}）`];
	});
	return info(
		[
			"规则没写的参数",
			...table(rows),
			"",
			rulesText(settings),
			...section("设置文件", table(fileRows(settings.files))),
		].join("\n"),
	);
}

/**
 * `/onward --scope <层> show [rules]`：这一份设置文件自己写了什么，不合并、不填默认值；合并后实际用的是 `/onward show`。
 * 规则照文件里写的列，参数只列规则自己写了的。
 */
export function layerNotice(settings: Settings, scope: Scope, rulesOnly: boolean): Notice {
	const file = settings.file(scope);
	if (!file) return warning("onward：还不知道当前目录，看不了项目级设置；会话开始之后再看");
	const title = `${SCOPE_NAMES[scope]}设置 ${fileState(file)}`;
	if (file.source.kind !== "file") return info(title);
	const { layer } = file;
	if (layer.problems.length)
		return info(
			[
				title,
				`有 ${layer.problems.length} 处问题，${UNTIL_FIXED}：`,
				...layer.problems.map((problem) => `- ${problem}`),
			].join("\n"),
		);
	const inherited = scope === "project" ? "全局设置" : "内置默认值";
	const params: [string, string][] = [
		...(layer.enabled === undefined ? [] : [["enabled", String(layer.enabled)] as [string, string]]),
		...FIELDS.filter((item) => Object.hasOwn(layer.defaults, item.name)).map((item): [string, string] => [
			item.name,
			shown(item, layer.defaults),
		]),
	];
	const rules =
		layer.rules === undefined
			? [`没写 rules，${scope === "project" ? "用全局设置的" : "没有规则"}`]
			: layerRules(layer.rules, scope);
	const head = rulesOnly ? [] : [...(params.length ? table(params) : [`  没写开关和参数，都用${inherited}的`]), ""];
	return info([title, ...head, ...rules, "", `合并后实际用的见 /${COMMAND} show`].join("\n"));
}

/** 一份设置文件里的 rules，照写的列：条件，和规则自己写了的参数。 */
function layerRules(rules: readonly Rule[], scope: Scope): string[] {
	if (!rules.length) return [`rules 是空的：${scope === "project" ? "这个项目里没有规则" : "没有规则"}`];
	return [
		`rules（${rules.length} 条，按顺序，第一条命中的生效）`,
		...rules.map((rule, index) => {
			const own = FIELDS.filter((item) => Object.hasOwn(rule.patch, item.name)).map(
				(item) => `${item.name}=${shown(item, rule.patch)}`,
			);
			const state = rule.enabled ? "" : "（已停用）";
			return `  ${index + 1}. ${rule.name}${state}：${describeWhen(rule)}${own.length ? `；${own.join(" ")}` : ""}`;
		}),
	];
}

function shown(item: Field, values: PolicyPatch): string {
	return (item as Field<typeof item.name>).show(values[item.name] as never);
}

/** `/onward show rules`。设置文件读不了时说读不了：规则一条也没读到，不是没写。 */
export function rulesNotice(settings: Settings): Notice {
	const broken = brokenFiles(settings);
	if (!broken.length) return info(rulesText(settings));
	return info(
		[`设置文件读不了，${UNTIL_FIXED}`, ...table(fileRows(broken)), "", `改好之后 /${COMMAND} reload`].join("\n"),
	);
}

/** 规则的全文。有项目级设置在用时，问题前面标上是哪一份的，规则前面说来自哪一份。 */
function rulesText(settings: Settings): string {
	const labelled = settings.projectFile !== undefined;
	const problems = settings.files.flatMap((file) =>
		file.layer.problems.map((problem) => (labelled ? `${SCOPE_NAMES[file.scope]}：${problem}` : problem)),
	);
	return describeRules({ ...settings.config, problems }, rulesFrom(settings));
}

/** 有项目级设置在用时，说规则来自哪一份；项目级的 rules 替换了全局的，也说一句。只有一份时不说。 */
function rulesFrom(settings: Settings): string | undefined {
	const origin = settings.origin("rules");
	if (settings.projectFile === undefined || origin === undefined) return undefined;
	const replaced = origin === "project" && settings.has("global", "rules");
	return `规则来自${SCOPE_NAMES[origin]}设置${replaced ? "，全局的 rules 不生效" : ""}`;
}

/** 改了开关或参数之后：有项目级设置在用、或者改的就是项目级时，说改的是哪一份；只有一份时说了也多余。 */
export function scopeLine(settings: Settings, scope: Scope): string | undefined {
	return scope === "project" || settings.projectFile !== undefined ? `改的是${SCOPE_NAMES[scope]}设置` : undefined;
}

/**
 * 改了全局、项目级又写了同名的：这个项目里还是按项目级的走，给出跟随全局的写法，和 wecom-aibot 一样。`keys` 是这次
 * 改到的开关和参数。
 */
export function shadowLine(settings: Settings, scope: Scope, keys: readonly string[]): string | undefined {
	const shadowed = scope === "global" ? keys.filter((key) => settings.has("project", key)) : [];
	return shadowed.length
		? `项目级设置也写了 ${shadowed.join("、")}，这个项目里仍按项目级的走；要跟随全局时运行 /${COMMAND} ${SCOPE} project unset ${shadowed.join(" ")}`
		: undefined;
}

/** reset 之后说做了什么。有项目级设置在用时，「恢复默认」不对：去掉的那份之外，另一份还在。 */
export function resetLine(settings: Settings, scope: Scope, keptRules: boolean): string {
	const done =
		scope === "project" || settings.projectFile !== undefined
			? `已去掉${SCOPE_NAMES[scope]}的开关和参数`
			: "已恢复默认";
	return keptRules ? `${done}，手写的 rules 保留` : done;
}

/** 一次修改之后：写好了就是当前状态，`done` 跟在标题后面；否则说明为什么。 */
export function changedNotice(saved: Saved, settings: Settings, progress: Progress, done?: string): Notice {
	switch (saved.kind) {
		case "saved":
			return statusNotice(settings, progress, done);
		case "broken":
			return warning(`${STOPPED} onward：${saved.path} 读不了（${saved.error}），先修好；未做任何修改`);
		case "unbound":
			return warning("onward：还不知道当前目录，改不了项目级设置；会话开始之后再改。未做任何修改");
		case "unwritten":
			return warning(
				`onward：设置没能保存（${saved.error}），这次运行仍按改过的设置走\n${statusText(settings, progress)}`,
			);
	}
}

// ── 设置说明 ──

/** 一组参数：怎么续跑、上限、间隔。`stop` 不续跑，只有一行。 */
function policyRows(policy: Policy): [string, string][] {
	if (policy.action === "stop") return [["做法", "命中就停，只提醒，不续跑"]];
	return [
		["做法", policy.action === "resend" ? "静默重发同一个请求" : `发「${policy.prompt}」`],
		["上限", `最多 ${policy.maxRetries} 次；同一个错误连续 ${policy.maxSameError} 次后也停`],
		["间隔", describeDelay(policy)],
	];
}

/**
 * 间隔表：列到不再变为止，后面的说「之后每次」；太长的中间用 … 省掉。单位都一样时只在最后写一次。
 * 例如 `3 → 6 → 9 → 12 → 15 秒，之后每次 15 秒；50 次合计约 12 分`。
 */
export function describeDelay(policy: Policy): string {
	const count = policy.maxRetries;
	const steps = Array.from({ length: count }, (_, i) => retryDelay(i + 1, policy.delay));
	// 从这一次起间隔不再变。
	let flat = count - 1;
	while (flat > 0 && steps[flat - 1] === steps[count - 1]) flat--;
	const total = `${count} 次合计约 ${formatDelay(totalDelay(count, policy.delay))}`;
	if (count === 1) return formatDelay(steps[0]!);
	if (flat === 0) return `每次 ${formatDelay(steps[0]!)}；${total}`;
	const shown = steps.slice(0, flat + 1);
	const head = shown.length > 7 ? [...shown.slice(0, 5), undefined, shown.at(-1)!] : shown;
	const tail = flat < count - 1 ? `，之后每次 ${formatDelay(steps[count - 1]!)}` : "";
	return `${sequence(head)}${tail}；${total}`;
}

/** `undefined` 是省掉的那段。单位都一样时数字之间不重复单位：`3 → 6 → 9 秒`。 */
function sequence(values: (number | undefined)[]): string {
	const texts = values.map((ms) => (ms === undefined ? "…" : formatDelay(ms)));
	const unit = (text: string) => /^[\d.]+ (毫秒|秒|分)$/.exec(text)?.[1];
	const units = new Set(texts.filter((text) => text !== "…").map(unit));
	if (units.size !== 1 || units.has(undefined)) return texts.join(" → ");
	const [only] = units;
	return `${texts.map((text) => text.replace(` ${only}`, "")).join(" → ")} ${only}`;
}

/**
 * `/onward show rules` 的全文。有问题时只列问题：规则反正不生效，列出来反而像在跑。`from` 说规则来自哪份设置文件，
 * 写在最前面。
 */
export function describeRules(config: Config, from?: string): string {
	if (config.problems.length)
		return `设置文件有 ${config.problems.length} 处问题，${UNTIL_FIXED}：\n${config.problems.map((p) => `- ${p}`).join("\n")}\n改完 /${COMMAND} reload`;
	const source = from ? [from] : [];
	if (!config.rules.length) return [...source, `没有可用的规则，出错时不会自动续跑。${addRules()}`].join("\n");
	const blocks = config.rules.map((rule, index) => {
		const rows: [string, string][] = [
			["条件", describeWhen(rule)],
			...policyRows(resolvePolicy(config.defaults, rule.patch)),
		];
		return [
			`${index + 1}. ${rule.name}${rule.enabled ? "" : "（已停用）"}`,
			...table(rows).map((line) => ` ${line}`),
		];
	});
	return [...source, "规则（按顺序，第一条命中的生效；没命中的错误和空回复不处理）", ...blocks.flat()].join("\n");
}

function describeWhen({ when }: Rule): string {
	const parts = [
		when.empty && "空回复",
		when.error && `错误匹配 /${when.error.source}/i`,
		when.provider && `provider=${when.provider}`,
		when.model && `model=${when.model}`,
	].filter(Boolean);
	return parts.length ? parts.join("，") : "任何错误";
}

/** 文件读不了，或者内容有读不懂的地方：读不了也记成一处问题。 */
function needsFix(settings: Settings): boolean {
	return settings.config.problems.length > 0;
}

function usableRules(config: Config): number {
	return config.rules.filter((rule) => rule.enabled).length;
}

// ── 运行中的通知 ──

/**
 * 启动时值得说的事：用上了项目级设置（仓库里带的设置能让 onward 替你给模型发消息，要让人知道）；设置文件读不了
 * 或有问题，说是哪一份（关着也说，可能就是 enabled 写错了）；没有可用的规则。
 */
export function startupNotices(settings: Settings): Notice[] {
	const { config } = settings;
	const project = settings.file("project");
	// 读不了的项目级文件不说「用上了」：下面的警告已经写了它的路径。
	const notices: Notice[] =
		project?.source.kind === "file" ? [info(`onward：用上了项目级设置 ${project.path}，它写了的字段覆盖全局的`)] : [];
	const broken = brokenFiles(settings);
	if (broken.length)
		return [
			...notices,
			...broken.map((file) =>
				warning(`${STOPPED} onward：${file.path} 读不了：${file.source.error}，${UNTIL_FIXED}`),
			),
		];
	if (config.problems.length)
		return [
			...notices,
			...settings.files
				.filter((file) => file.layer.problems.length)
				.map((file) =>
					warning(
						`${STOPPED} onward：${file.path} 有 ${file.layer.problems.length} 处问题，${UNTIL_FIXED}（/${COMMAND} show 查看）`,
					),
				),
		];
	if (config.enabled && !usableRules(config)) {
		const where = (settings.origin("rules") === "project" && project) || settings.file("global");
		notices.push(info(`${IDLE} onward：没有可用的规则，出错时不会自动续跑；${addRules(` ${where.path} `)}`));
	}
	return notices;
}

/**
 * 状态栏已经写了第几次、哪条规则，这里只说接下来做什么：`onward：3 秒后静默重发`。出错时 pi 已经显示过错误；
 * 空回复 pi 什么都不显示，所以先说一句：`onward：空回复，3 秒后发「继续」`。
 */
export function retryNotice(step: Retry, draft: Continue, failure: Failure): Notice {
	const action = draft.type === "context_edit" ? "静默重发" : `发「${truncate(draft.content, 30)}」`;
	const what = failure.stopReason === "stop" ? `${EMPTY_REPLY}，` : "";
	return info(`onward：${what}${formatDelay(step.delay)}后${action}`);
}

/** 状态栏已经写了停了、哪条规则，这里只说为什么停、怎么办。 */
export function giveUpNotice(step: GiveUp): Notice {
	const again = "；发任意消息重新计数";
	switch (step.reason) {
		case "stop":
			return warning("onward：这条规则只提醒，需要你自己处理");
		case "same-error":
			return warning(`onward：同一个错误已连续 ${step.streak} 次${again}`);
		case "budget":
			return warning(`onward：已续跑 ${step.attempt} 次仍未恢复${again}`);
	}
}

/** 状态栏：正在续跑第几次。 */
export function retryStatus(hit: Hit, step: Retry): string {
	return `${RUNNING} ${progressText(hit.rule.name, step.attempt, hit.policy.maxRetries)}`;
}

/** 状态栏：停了，留到恢复或用户发新消息。 */
export function giveUpStatus(hit: Hit, step: GiveUp): string {
	return `${STOPPED} ${step.reason === "stop" ? "不续跑" : "续跑已停"} · ${hit.rule.name}`;
}

/** 续跑消息在会话里的标签。`details` 来自会话记录文件，按 unknown 读：字段齐全才写第几次和规则名。 */
export function continueLabel(details: unknown): string {
	if (!isRecord(details)) return `${RUNNING} onward`;
	const { rule, attempt, max } = details;
	return typeof rule === "string" && Number.isInteger(attempt) && Number.isInteger(max)
		? `${RUNNING} onward · ${progressText(rule, attempt as number, max as number)}`
		: `${RUNNING} onward`;
}

function progressText(rule: string, attempt: number, max: number): string {
	return `续跑 ${attempt}/${max} · ${rule}`;
}

/** 归一化后的错误摘要，不带每次都变的 request id。 */
export function errorExcerpt(failure: Failure, limit = 40): string {
	return truncate(errorSignature(failure), limit);
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
