/** 给用户看的通知和设置说明；命令的用法在 command.ts，和命令的写法放在一起。 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config, Hit } from "../policy/config.ts";
import { formatDelay, retryDelay, totalDelay } from "../policy/delay.ts";
import { errorSignature, type Failure } from "../policy/failure.ts";
import { DEFAULT_POLICY, FIELDS, type Field, type Policy, resolvePolicy } from "../policy/policy.ts";
import type { Rule } from "../policy/rules.ts";
import type { GiveUp, Progress, Retry } from "../policy/tracker.ts";
import type { Continue } from "./onward.ts";
import type { Saved, Settings } from "./settings.ts";

export const COMMAND = "onward";

export interface Notice {
	message: string;
	level: "info" | "warning";
}

/** 没有界面（`pi -p`、RPC）时不提示。 */
export function say(ctx: Pick<ExtensionContext, "hasUI" | "ui">, notice: Notice): void {
	if (ctx.hasUI) ctx.ui.notify(notice.message, notice.level);
}

export const info = (message: string): Notice => ({ message, level: "info" });
const warning = (message: string): Notice => ({ message, level: "warning" });

const NO_RULES = "没有可用的规则，出错时不会自动续跑";
const SEE_README = "常见规则见 README";
const UNTIL_FIXED = "修好之前不会自动续跑";

// ── /onward ──

export function commandErrorNotice(message: string): Notice {
	return warning(`onward：${message}；用法见 /${COMMAND} --help`);
}

export function rulesNotice(config: Config): Notice {
	return info(describeRules(config));
}

/** `/onward show`：每个参数的值和它从哪来，再是规则。 */
export function showNotice(settings: Settings): Notice {
	const { defaults } = settings.config;
	const where = describeSource(settings);
	const rows = FIELDS.map((item) => {
		const set = Object.hasOwn(defaults, item.name);
		const value = (set ? defaults : DEFAULT_POLICY)[item.name] as never;
		return `  ${item.name.padEnd(13)}${(item as Field<typeof item.name>).show(value)}（${set ? "设置文件" : "内置默认值"}）`;
	});
	return info([`参数（规则没写的字段用它；${where}）：`, ...rows, "", describeRules(settings.config)].join("\n"));
}

export function statusNotice(settings: Settings, progress: Progress): Notice {
	return { message: statusText(settings, progress), level: needsFix(settings) ? "warning" : "info" };
}

/** 一次修改之后：写好了就是当前状态，`done` 跟在后面；否则说明为什么。 */
export function changedNotice(saved: Saved, settings: Settings, progress: Progress, done = ""): Notice {
	switch (saved.kind) {
		case "saved":
			return { message: `${statusText(settings, progress)}${done}`, level: needsFix(settings) ? "warning" : "info" };
		case "broken":
			return warning(`onward：${settings.path} 读不了（${saved.error}），先修好；未做任何修改`);
		case "unwritten":
			return warning(`onward：设置没能保存（${saved.error}），本次运行仍然生效\n${statusText(settings, progress)}`);
	}
}

// ── 设置说明 ──

/** 方式、次数、间隔表、合计、同错上限。 */
export function describePolicy(policy: Policy): string {
	if (policy.action === "stop") return "命中就停，只提醒，不续跑";
	const how = policy.action === "resend" ? "静默重发同一请求" : `发「${policy.prompt}」`;
	const shown = Math.min(policy.maxRetries, 6);
	const steps = Array.from({ length: shown }, (_, i) => formatDelay(retryDelay(i + 1, policy.delay)));
	const more = policy.maxRetries > shown ? " …" : "";
	const total = formatDelay(totalDelay(policy.maxRetries, policy.delay));
	return `${how}，最多 ${policy.maxRetries} 次；间隔 ${steps.join(" → ")}${more}（合计约 ${total}）；同一个错误连续 ${policy.maxSameError} 次后也停`;
}

/** `/onward show rules` 的全文。有问题时只列问题：规则反正不生效，列出来反而像在跑。 */
export function describeRules(config: Config): string {
	if (config.problems.length)
		return `设置文件有 ${config.problems.length} 处问题，${UNTIL_FIXED}：\n${config.problems.map((p) => `- ${p}`).join("\n")}\n改完 /${COMMAND} reload`;
	if (!config.rules.length) return `${NO_RULES}。在设置文件的 rules 里写（${SEE_README}），再 /${COMMAND} reload`;
	const lines = config.rules.map((rule, index) => {
		const state = rule.enabled ? "" : "（已停用）";
		const policy = describePolicy(resolvePolicy(config.defaults, rule.patch));
		return `${index + 1}. ${rule.name}${state}：${describeWhen(rule)} → ${policy}`;
	});
	return `按顺序第一条命中的生效，没有命中的错误不处理：\n${lines.join("\n")}`;
}

function describeWhen({ when }: Rule): string {
	const parts = [
		when.error && `错误匹配 /${when.error.source}/i`,
		when.provider && `provider=${when.provider}`,
		when.model && `model=${when.model}`,
	].filter(Boolean);
	return parts.length ? parts.join("，") : "任何错误";
}

function statusText(settings: Settings, { used, streak }: Progress): string {
	const { config } = settings;
	const problems = problemCount(config);
	if (!config.enabled) return ["onward：关", problems, describeSource(settings)].filter(Boolean).join("；");
	if (problems) return [`onward：开，但${problems}`, describeSource(settings)].join("；");
	const usable = usableRules(config);
	return [
		usable
			? `onward：开，${usable} 条规则生效（/${COMMAND} show rules）`
			: `onward：开，${NO_RULES}（${SEE_README}）`,
		`规则没写的参数：${describePolicy(resolvePolicy(config.defaults))}`,
		describeSource(settings),
		used || streak ? `恢复前已续跑 ${used} 次，同错连续 ${streak} 次` : "",
	]
		.filter(Boolean)
		.join("；");
}

function describeSource({ source, path }: Settings): string {
	switch (source.kind) {
		case "file":
			return `设置文件 ${path}`;
		case "none":
			return `还没有设置文件（${path}）`;
		case "broken":
			return `${path} 读不了：${source.error}，${UNTIL_FIXED}`;
	}
}

/** 文件读不了，或者内容有读不懂的地方。 */
function needsFix(settings: Settings): boolean {
	return settings.source.kind === "broken" || settings.config.problems.length > 0;
}

function usableRules(config: Config): number {
	return config.rules.filter((rule) => rule.enabled).length;
}

function problemCount(config: Config): string {
	return config.problems.length
		? `设置文件有 ${config.problems.length} 处问题，${UNTIL_FIXED}（/${COMMAND} show）`
		: "";
}

// ── 运行中的通知 ──

/** 启动时值得说的事：设置文件读不了或有问题（关着也说，可能就是 enabled 写错了）、没有可用的规则。 */
export function startupNotices(settings: Settings): Notice[] {
	const { config, source, path } = settings;
	if (source.kind === "broken") return [warning(`onward：${describeSource(settings)}`)];
	if (config.problems.length) return [warning(`onward：${path} ${problemCount(config)}`)];
	if (config.enabled && !usableRules(config))
		return [info(`onward：${NO_RULES}；在 ${path} 的 rules 里写（${SEE_README}）`)];
	return [];
}

export function retryNotice(hit: Hit, step: Retry, draft: Continue): Notice {
	const action = draft.type === "context_edit" ? "静默重发" : `发「${truncate(draft.content, 30)}」`;
	return info(
		`onward：规则 ${hit.rule.name}：上游错误（${errorExcerpt(hit.failure)}），${formatDelay(step.delay)}后${action}（第 ${step.attempt}/${hit.policy.maxRetries} 次）`,
	);
}

/** 状态栏：正在续跑第几次。 */
export function retryStatus(hit: Hit, step: Retry): string {
	return `⏩ 续跑 ${step.attempt}/${hit.policy.maxRetries} · ${hit.rule.name}`;
}

/** 状态栏：停了，留到恢复或用户发新消息。 */
export function giveUpStatus(hit: Hit, step: GiveUp): string {
	return `⏩ ${step.reason === "stop" ? "不续跑" : "续跑已停"} · ${hit.rule.name}`;
}

export function giveUpNotice(hit: Hit, step: GiveUp): Notice {
	const head = `onward：规则 ${hit.rule.name}：`;
	const tail = "，不再自动续跑；输入任意消息可重置";
	switch (step.reason) {
		case "stop":
			return warning(`${head}${errorExcerpt(hit.failure)}，按规则不续跑`);
		case "same-error":
			return warning(`${head}同一个错误已连续 ${step.streak} 次（${errorExcerpt(hit.failure)}）${tail}`);
		case "budget":
			return warning(`${head}已续跑 ${step.attempt} 次仍未恢复${tail}`);
	}
}

/** 归一化后的错误摘要，不带每次都变的 request id。 */
export function errorExcerpt(failure: Failure, limit = 40): string {
	return truncate(errorSignature(failure), limit);
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
