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
import { DEFAULT_POLICY, FIELDS, type Field, type Policy, resolvePolicy } from "../policy/policy.ts";
import type { Rule } from "../policy/rules.ts";
import type { GiveUp, Progress, Retry } from "../policy/tracker.ts";
import { isRecord } from "../util.ts";
import type { Continue } from "./onward.ts";
import type { Saved, Settings } from "./settings.ts";

export const COMMAND = "onward";

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

/** 一行说清现在会不会续跑：`/onward status` 的第一行，也是 `/onward` 菜单的标题。 */
export function statusHeadline(settings: Settings): string {
	const { config, source } = settings;
	if (source.kind === "broken") return `${STOPPED} onward：设置文件读不了，${UNTIL_FIXED}`;
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
	const { config, source } = settings;
	const lines = [statusHeadline(settings), ...(note ? [note] : [])];
	if (used || streak) lines.push(`上次正常返回之后已续跑 ${used} 次，同一个错误连续 ${streak} 次`);
	const usable = source.kind !== "broken" && !config.problems.length;
	if (usable) lines.push(...section("规则没写的参数", table(policyRows(resolvePolicy(config.defaults)))));
	lines.push(...section("设置文件", fileLines(settings)), "");
	if (!usable) lines.push(`改好之后 /${COMMAND} reload；问题见 /${COMMAND} show`);
	else if (!config.enabled) lines.push(`/${COMMAND} on 打开`);
	else if (!usableRules(config)) lines.push(addRules());
	else lines.push(`规则见 /${COMMAND} show rules`);
	return lines.join("\n");
}

/** 设置文件在哪、能不能读。 */
function fileLines({ source, path }: Settings): string[] {
	switch (source.kind) {
		case "file":
			return [`  ${path}`];
		case "none":
			return [`  ${path}（还没有，改设置时自动建）`];
		case "broken":
			return [`  ${path}`, `  读不了：${source.error}`];
	}
}

/** `/onward show`：每个参数的值和它从哪来，再是规则，最后是设置文件。 */
export function showNotice(settings: Settings): Notice {
	if (settings.source.kind === "broken") return rulesNotice(settings);
	const { defaults } = settings.config;
	const rows = FIELDS.map((item): [string, string] => {
		const set = Object.hasOwn(defaults, item.name);
		const value = (set ? defaults : DEFAULT_POLICY)[item.name] as never;
		return [item.name, `${(item as Field<typeof item.name>).show(value)}（${set ? "设置文件" : "内置默认值"}）`];
	});
	return info(
		[
			"规则没写的参数",
			...table(rows),
			"",
			describeRules(settings.config),
			...section("设置文件", fileLines(settings)),
		].join("\n"),
	);
}

/** `/onward show rules`。设置文件读不了时说读不了：规则一条也没读到，不是没写。 */
export function rulesNotice(settings: Settings): Notice {
	if (settings.source.kind !== "broken") return info(describeRules(settings.config));
	return info(
		[`设置文件读不了，${UNTIL_FIXED}`, ...fileLines(settings), "", `改好之后 /${COMMAND} reload`].join("\n"),
	);
}

/** 一次修改之后：写好了就是当前状态，`done` 跟在标题后面；否则说明为什么。 */
export function changedNotice(saved: Saved, settings: Settings, progress: Progress, done?: string): Notice {
	switch (saved.kind) {
		case "saved":
			return statusNotice(settings, progress, done);
		case "broken":
			return warning(`${STOPPED} onward：${settings.path} 读不了（${saved.error}），先修好；未做任何修改`);
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

/** `/onward show rules` 的全文。有问题时只列问题：规则反正不生效，列出来反而像在跑。 */
export function describeRules(config: Config): string {
	if (config.problems.length)
		return `设置文件有 ${config.problems.length} 处问题，${UNTIL_FIXED}：\n${config.problems.map((p) => `- ${p}`).join("\n")}\n改完 /${COMMAND} reload`;
	if (!config.rules.length) return `没有可用的规则，出错时不会自动续跑。${addRules()}`;
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
	return ["规则（按顺序，第一条命中的生效；没命中的错误和空回复不处理）", ...blocks.flat()].join("\n");
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

/** 文件读不了，或者内容有读不懂的地方。 */
function needsFix(settings: Settings): boolean {
	return settings.source.kind === "broken" || settings.config.problems.length > 0;
}

function usableRules(config: Config): number {
	return config.rules.filter((rule) => rule.enabled).length;
}

// ── 运行中的通知 ──

/** 启动时值得说的事：设置文件读不了或有问题（关着也说，可能就是 enabled 写错了）、没有可用的规则。 */
export function startupNotices(settings: Settings): Notice[] {
	const { config, source, path } = settings;
	if (source.kind === "broken") return [warning(`${STOPPED} onward：${path} 读不了：${source.error}，${UNTIL_FIXED}`)];
	if (config.problems.length)
		return [
			warning(
				`${STOPPED} onward：设置文件有 ${config.problems.length} 处问题，${UNTIL_FIXED}（/${COMMAND} show 查看）`,
			),
		];
	if (config.enabled && !usableRules(config))
		return [info(`${IDLE} onward：没有可用的规则，出错时不会自动续跑；${addRules(` ${path} `)}`)];
	return [];
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

/** 续跑消息在会话里的标签；`details` 来自会话记录，旧的或别处写的可能不全。 */
export function continueLabel(details: unknown): string {
	if (!isRecord(details) || typeof details.rule !== "string") return `${RUNNING} onward`;
	const { rule, attempt, max } = details;
	return Number.isInteger(attempt) && Number.isInteger(max)
		? `${RUNNING} onward · ${progressText(rule, attempt as number, max as number)}`
		: `${RUNNING} onward · ${rule}`;
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
