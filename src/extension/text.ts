/** 给用户看的全部文字：用法、设置说明、通知。 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config, Hit } from "../policy/config.ts";
import { formatDelay, retryDelay, totalDelay } from "../policy/delay.ts";
import { errorSignature, type Failure } from "../policy/failure.ts";
import { type Policy, resolvePolicy } from "../policy/policy.ts";
import type { Rule } from "../policy/rules.ts";
import type { Progress, Retry, Stop } from "../policy/tracker.ts";
import type { Settings } from "./settings.ts";

export const COMMAND = "onward";
/** 旧的单文件扩展注册的命令；两个同时装，出错时会各续跑一次。 */
export const LEGACY_COMMAND = "auto-continue";

export interface Notice {
	message: string;
	level: "info" | "warning" | "error";
}

/** 没有界面（`pi -p`、RPC）时不提示。 */
export function say(ctx: Pick<ExtensionContext, "hasUI" | "ui">, notice: Notice): void {
	if (ctx.hasUI) ctx.ui.notify(notice.message, notice.level);
}

const info = (message: string): Notice => ({ message, level: "info" });
const warning = (message: string): Notice => ({ message, level: "warning" });

const NO_RULES = "没有可用的规则，出错时不会自动续跑";

// ── /onward ──

export const DESCRIPTION =
	"出错后按规则自动续跑：/onward [on|off|message|silent|N|5s,10s|base= cap=|ramp|same=N|prompt=|rules|reload|reset]";

export const USAGE = [
	`/${COMMAND}                    看当前设置`,
	`/${COMMAND} on | off           开关`,
	"下面几项改的是 defaults：规则自己没写的参数用它",
	`/${COMMAND} message | silent   续跑方式：发一条消息 / 静默重发同一请求`,
	`/${COMMAND} 10                 最多续跑 10 次`,
	`/${COMMAND} 5s,10s,30s         写死间隔列表（最后一个值重复）`,
	`/${COMMAND} base=3s cap=15s    按次数增长：第 n 次等 min(base×n, cap)`,
	`/${COMMAND} ramp               清掉间隔列表，回到按次数增长`,
	`/${COMMAND} same=10            同一个错误连续 10 次后，第 11 次彻底停`,
	`/${COMMAND} prompt=继续         message 模式发的消息，可含 {attempt} {max} {error} {rule}`,
	`/${COMMAND} rules              列出规则与设置文件里的问题（规则要手写，示例见 README）`,
	`/${COMMAND} reload             重新读设置文件（手改 rules 之后用）`,
	`/${COMMAND} reset              恢复默认（保留手写的 rules）`,
].join("\n");

export function helpNotice(): Notice {
	return info(USAGE);
}

export function commandErrorNotice(message: string): Notice {
	return warning(`onward：${message}\n${USAGE}`);
}

export function rulesNotice(config: Config): Notice {
	return info(describeRules(config));
}

export function statusNotice(settings: Settings, progress: Progress): Notice {
	return { message: statusText(settings, progress), level: settings.source.kind === "broken" ? "warning" : "info" };
}

export function saveFailedNotice(error: string, settings: Settings, progress: Progress): Notice {
	return warning(`onward：设置没能保存（${error}），本次运行仍然生效\n${statusText(settings, progress)}`);
}

export function resetNotice(settings: Settings, keptRules: boolean): Notice {
	const done = keptRules ? "（已恢复默认，手写的 rules 保留）" : "（已恢复默认）";
	return info(`${statusText(settings, { used: 0, streak: 0 })}${done}`);
}

export function resetFailedNotice(error: string): Notice {
	return warning(`onward：${error}`);
}

// ── 设置说明 ──

/** 方式、次数、间隔表、合计、同错上限。 */
export function describePolicy(policy: Policy): string {
	const how = policy.mode === "silent" ? "静默重发同一请求" : `发「${policy.prompt}」`;
	if (policy.maxRetries === 0) return `${how}，次数为 0（不续跑）`;
	const shown = Math.min(policy.maxRetries, 6);
	const steps = Array.from({ length: shown }, (_, i) => formatDelay(retryDelay(i + 1, policy)));
	const more = policy.maxRetries > shown ? " …" : "";
	const total = formatDelay(totalDelay(policy.maxRetries, policy));
	return `${how}，最多 ${policy.maxRetries} 次；间隔 ${steps.join(" → ")}${more}（合计约 ${total}）；同错连续 ${policy.sameErrorLimit} 次也停`;
}

/** `/onward rules` 的全文。 */
export function describeRules(config: Config): string {
	const problems = config.problems.length
		? `\n设置文件里的问题：\n${config.problems.map((p) => `- ${p}`).join("\n")}`
		: "";
	if (!config.rules.length)
		return `${NO_RULES}。在设置文件的 rules 里写（常见规则见 README），再 /${COMMAND} reload。${problems}`;
	const lines = config.rules.map((rule, index) => {
		const state = rule.enabled ? "" : "（已停用）";
		const policy = describePolicy(resolvePolicy(config.defaults, rule.patch));
		return `${index + 1}. ${rule.name}${state}：${describeWhen(rule)} → ${policy}`;
	});
	return `按顺序第一条命中的生效，没有命中的错误不处理：\n${lines.join("\n")}${problems}`;
}

function describeWhen({ when }: Rule): string {
	const parts = [
		when.match && `错误匹配 /${when.match}/i`,
		when.provider && `provider=${when.provider}`,
		when.model && `model=${when.model}`,
	].filter(Boolean);
	return parts.length ? parts.join("，") : "任何错误";
}

function statusText(settings: Settings, { used, streak }: Progress): string {
	const { config } = settings;
	if (!config.enabled) return `onward：关；${describeSource(settings)}`;
	const usable = usableRules(config);
	return [
		usable ? `onward：开，${usable} 条规则生效（/${COMMAND} rules）` : `onward：开，${NO_RULES}（常见规则见 README）`,
		`规则没写的参数用 defaults：${describePolicy(resolvePolicy(config.defaults))}`,
		describeSource(settings),
		problemCount(config),
		used || streak ? `恢复前已续跑 ${used} 次，同错连续 ${streak} 次` : "",
	]
		.filter(Boolean)
		.join("；");
}

function describeSource({ source, path, legacyPath }: Settings): string {
	switch (source.kind) {
		case "file":
			return `设置文件 ${path}`;
		case "legacy":
			return `读的是旧设置文件 ${legacyPath}，下次修改时写到 ${path}`;
		case "none":
			return `还没有设置文件（${path}）`;
		case "broken":
			return `${path} 读不了：${source.error}，修好之前不会自动续跑`;
	}
}

function usableRules(config: Config): number {
	return config.rules.filter((rule) => rule.enabled).length;
}

function problemCount(config: Config): string {
	return config.problems.length ? `设置文件有 ${config.problems.length} 处问题（/${COMMAND} rules）` : "";
}

// ── 运行中的通知 ──

/** 启动时值得说的事：设置文件坏了、没有可用的规则、旧扩展还装着。 */
export function startupNotices(settings: Settings, legacyInstalled: boolean): Notice[] {
	const { config, source, path } = settings;
	const notices: Notice[] = [];
	if (source.kind === "broken") notices.push(warning(`onward：${describeSource(settings)}`));
	else if (config.enabled && !usableRules(config)) {
		const problems = problemCount(config);
		const message = `onward：${NO_RULES}；在 ${path} 的 rules 里写（常见规则见 README）${problems && `；${problems}`}`;
		notices.push(problems ? warning(message) : info(message));
	}
	if (legacyInstalled)
		notices.push(
			warning(
				`onward：旧的 /${LEGACY_COMMAND} 扩展也装着，出错时会续跑两次；删掉 extensions/auto-continue.ts 再 /reload`,
			),
		);
	return notices;
}

/** `prompt` 不给表示静默重发。 */
export function retryNotice(hit: Hit, step: Retry, prompt?: string): Notice {
	const action = prompt === undefined ? "静默重发" : `发「${truncate(prompt, 30)}」`;
	return info(
		`onward：规则 ${hit.rule.name}：上游错误（${errorExcerpt(hit.failure)}），${formatDelay(step.delay)}后${action}（第 ${step.attempt}/${hit.policy.maxRetries} 次）`,
	);
}

export function stopNotice(hit: Hit, step: Stop): Notice {
	const head = `onward：规则 ${hit.rule.name}：`;
	const tail = "，不再自动续跑；输入任意消息可重置";
	switch (step.reason) {
		case "no-retries":
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
