/** UI-only descriptions. Model-visible text is produced solely by action implementations. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActionDefinition } from "../actions/protocol.ts";
import { type Config, configWarnings } from "../policy/config.ts";
import { delayText } from "../policy/delay.ts";
import { FIELDS, fieldNamed, type LimitsPatch, resolveLimits } from "../policy/policy.ts";
import type { Rule } from "../policy/rules.ts";
import type { OnwardStatus, RunState } from "../runtime/recovery.ts";
import type { Saved, Scope, Settings, SettingsFile } from "./settings.ts";

export const COMMAND = "onward";
export const SCOPE = "--scope";
export interface Notice {
	message: string;
	level: "info" | "warning";
}
export const info = (message: string): Notice => ({ message, level: "info" });
const warning = (message: string): Notice => ({ message, level: "warning" });
const NAMES = { global: "全局", project: "项目级" } as const;
export function say(ctx: Pick<ExtensionContext, "hasUI" | "ui">, notice: Notice): void {
	if (ctx.hasUI) ctx.ui.notify(notice.message, notice.level);
}
export function cells(text: string): number {
	return [...text].reduce(
		(sum, char) =>
			sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1),
		0,
	);
}
export function table(rows: [string, string][]): string[] {
	const width = Math.max(0, ...rows.map(([key]) => cells(key)));
	return rows.flatMap(([key, value]) => {
		const [first, ...rest] = value.split("\n");
		return [
			`  ${key}${" ".repeat(width - cells(key))}  ${first}`,
			...rest.map((line) => `  ${" ".repeat(width)}  ${line}`),
		];
	});
}
export function columns(rows: [string, string][]): string[] {
	const width = Math.max(0, ...rows.map(([key]) => cells(key)));
	return rows.map(([key, value]) => `${key}${" ".repeat(width - cells(key))}  ${value.replace(/\s*\n\s*/g, " ")}`);
}
export function section(title: string, lines: string[]): string[] {
	return lines.length ? ["", title, ...lines] : [];
}
export function commandErrorNotice(message: string, topic?: string): Notice {
	return warning(`onward: ${message}; see /onward${topic ? ` ${topic}` : ""} --help for usage`);
}
export const layerMenuText = (scope: Scope): string => `只看、只改${NAMES[scope]}设置`;
export function menuTitle(settings: Settings, scope?: Scope, state?: RunState): string {
	return `${statusHeadline(settings, state)} · ${scope ? `${NAMES[scope]}设置` : "修改默认写入：全局设置"}`;
}
const PHASES: Record<RunState["phase"], string> = {
	idle: "待命",
	waiting: "等待执行",
	submitted: "提议已提交，等待启动",
	retrying: "续跑中",
	queued: "待执行",
	executing: "执行中",
	stopped: "已停止",
};
const RESULTS: Record<string, string> = {
	completed: "已完成",
	dispatched: "已分派，业务结果未知",
	handoff: "已接管",
	stopped: "规则停止",
	failed: "执行失败",
	cancelled: "已取消",
	unknown: "结果未知",
};
function usable(config: Config): number {
	return config.rules.filter((rule) => rule.enabled).length;
}
export function statusHeadline(settings: Settings, state?: RunState): string {
	const config = settings.config;
	if (config.problems.length) return "🛑 onward：配置无效，修好之前不会自动恢复";
	if (!config.enabled) return "💤 onward：关，出错时不会自动恢复";
	if (state && state.phase !== "idle")
		return `${state.phase === "stopped" ? "🛑" : "⏩"} onward：${state.result ? RESULTS[state.result] : PHASES[state.phase]}`;
	return usable(config) ? `⏩ onward：开，${usable(config)} 条规则生效` : "💤 onward：开，但没有可用的规则";
}
export function statusNotice(settings: Settings, status: OnwardStatus): Notice {
	const config = settings.config;
	const { state } = status;
	const rows: [string, string][] = [
		["自动恢复", config.enabled ? "已启用" : "已停用"],
		[
			"当前状态",
			config.problems.length
				? "配置无效"
				: !config.enabled
					? "未在恢复"
					: state.phase === "idle" && !usable(config)
						? "无可用规则"
						: PHASES[state.phase],
		],
	];
	if (config.problems.length) rows.push(["配置问题", `${config.problems.length} 处，/onward show 查看详情`]);
	else {
		if (state.phase === "idle") rows.push(["可用规则", `${usable(config)} 条`]);
		if (state.hit)
			rows.push(
				["命中规则", state.hit.rule.name],
				["恢复阶段", `从第 ${state.hit.stage.minFailures} 次失败开始`],
				["动作", state.hit.stage.action.use],
			);
		if (status.failures) rows.push(["连续失败", `${status.failures} 次`]);
		if (status.started) rows.push(["已启动续跑", `${status.started} 次`]);
		if (status.handoffs) rows.push(["跨会话接管", `${status.handoffs} 次`]);
		if (state.result) rows.push(["动作结果", RESULTS[state.result] ?? state.result]);
		if (state.message) rows.push(["说明", state.message]);
	}
	const lines = [COMMAND, ...table(rows)];
	const attention = state.phase === "stopped" && !["completed", "dispatched", "handoff"].includes(state.result ?? "");
	if (state.phase === "stopped") {
		const hint =
			state.result === "dispatched"
				? "后续执行与结果由目标插件负责；onward 不会自动重放命令。"
				: state.result === "handoff"
					? "后续恢复由动作提供者负责。"
					: state.result === "completed"
						? "本次动作已完成；没有自动追加模型请求。"
						: "处理原因后发消息开启新一轮；未自动重放动作。";
		lines.push("", hint);
	}
	return attention || config.problems.length ? warning(lines.join("\n")) : info(lines.join("\n"));
}
export function actionsNotice(actions: readonly ActionDefinition[], diagnostics: readonly string[]): Notice {
	const text = [
		"onward 动作",
		...table(
			actions.map((action) => [
				action.name,
				`${action.description}（${action.phase}；${action.modes.join(" / ")}）`,
			]),
		),
		...section(
			"动作注册问题",
			diagnostics.map((message) => `- ${message}`),
		),
	].join("\n");
	return diagnostics.length ? warning(text) : info(text);
}

function fileRows(files: readonly SettingsFile[]): [string, string][] {
	const sources = { file: "", none: "（未创建）", broken: "（无法读取）", untrusted: "（未受信任，未读取）" };
	return files.map((file) => [
		NAMES[file.scope],
		`${file.path}${sources[file.source.kind]}${file.unsaved.length ? `（未保存：${file.unsaved.join("、")}）` : ""}`,
	]);
}
function showProblems(settings: Settings): Notice {
	return warning(
		[
			"onward 配置无效，修好之前不会自动恢复。",
			...settings.config.problems.map((problem) => `- ${problem}`),
			...section("配置文件", table(fileRows(settings.files))),
			"",
			"修复后 /onward reload；加载插件使用 Pi 的 /reload。",
		].join("\n"),
	);
}
function effective(settings: Settings, key: string): string {
	const { config } = settings;
	if (key === "quietStartup" && config.quietStartup === undefined) return "跟随 Pi（未配置）";
	const value =
		key === "enabled" || key === "quietStartup" ? String(config[key]) : shown(key, resolveLimits(config.limits));
	const origin = settings.origin(key);
	const source = origin
		? `${NAMES[origin]}配置${settings.file(origin)!.unsaved.includes(key) ? "，未保存" : ""}`
		: "内置默认值";
	return `${value}（${source}）`;
}
function shown(key: string, values: LimitsPatch): string {
	const field = fieldNamed(key)!;
	return field.show(values[field.name]!);
}
export function showNotice(settings: Settings): Notice {
	if (settings.config.problems.length) return showProblems(settings);
	return info(
		[
			"onward 配置（合并结果）",
			...section("开关与启动提示", table(["enabled", "quietStartup"].map((key) => [key, effective(settings, key)]))),
			...section("恢复上限", table(FIELDS.map((field) => [field.name, effective(settings, field.name)]))),
			"",
			rulesText(settings),
			...section("配置文件", table(fileRows(settings.files))),
		].join("\n"),
	);
}
export function rulesNotice(settings: Settings): Notice {
	return settings.config.problems.length ? showProblems(settings) : info(rulesText(settings));
}
function rulesText(settings: Settings): string {
	const origin = settings.origin("rules");
	return describeRules(
		settings.config,
		`规则（${settings.config.rules.length} 条，${origin ? `来源：${NAMES[origin]}配置` : "未配置"}）${origin === "project" && settings.has("global", "rules") ? "\n项目级 rules 整份替换全局 rules。" : ""}`,
	);
}
export function describeRules(config: Config, title = `规则（${config.rules.length} 条）`): string {
	if (config.problems.length) return config.problems.join("\n");
	const lines = [title, "按顺序匹配第一条规则；按连续失败次数选择已达到阈值的最后一个阶段。"];
	if (!config.rules.length) lines.push("没有可用的规则；在设置文件的 rules 里写规则，再 /onward reload。");
	for (const [index, rule] of config.rules.entries()) {
		lines.push(`${index + 1}. ${rule.name}${rule.enabled ? "" : "（已停用）"}：${describeWhen(rule)}`);
		for (const stage of rule.stages)
			lines.push(
				`  从第 ${stage.minFailures} 次失败：${stage.action.use}；间隔 ${delayText(stage.delay)}${stage.action.with ? `；参数 ${JSON.stringify(stage.action.with)}` : ""}`,
			);
	}
	lines.push(...section("规则提醒（不影响设置生效）", configWarnings(config)));
	return lines.join("\n");
}
function describeWhen({ when }: Rule): string {
	return (
		[
			when.failure && `失败匹配 /${when.failure.source}/i`,
			when.provider && `provider=${when.provider}`,
			when.model && `model=${when.model}`,
		]
			.filter(Boolean)
			.join("，") || "任何失败"
	);
}
export function layerNotice(settings: Settings, scope: Scope, rulesOnly: boolean): Notice {
	const file = settings.file(scope);
	if (!file) return warning("onward：当前目录尚未确定，请在会话开始后重试。");
	const lines = [`onward ${rulesOnly ? "规则" : "配置"}（${NAMES[scope]}，仅本层配置）`];
	if (file.source.kind === "untrusted")
		return warning([...lines, "项目未受信任，未读取项目配置。", ...table(fileRows([file]))].join("\n"));
	if (file.layer.problems.length)
		return warning([...lines, ...file.layer.problems, ...section("配置文件", table(fileRows([file])))].join("\n"));
	if (file.unsaved.length) lines.push(`未保存的配置项：${file.unsaved.join("、")}；重载后以磁盘为准。`);
	if (file.source.kind === "none") lines.push("配置文件未创建。");
	if (!rulesOnly) {
		const rows: [string, string][] = [];
		if (file.layer.enabled !== undefined) rows.push(["enabled", String(file.layer.enabled)]);
		if (file.layer.quietStartup !== undefined) rows.push(["quietStartup", String(file.layer.quietStartup)]);
		for (const field of FIELDS)
			if (Object.hasOwn(file.layer.limits, field.name))
				rows.push([field.name, shown(field.name, file.layer.limits)]);
		lines.push(...table(rows));
	}
	if (file.layer.rules === undefined)
		lines.push(`未写 rules，${scope === "project" ? "继承全局配置的规则" : "没有规则"}。`);
	else if (!file.layer.rules.length)
		lines.push(`规则（0 条，显式空列表）；${scope === "project" ? "不使用全局规则" : "没有规则"}。`);
	else lines.push(describeRules({ enabled: true, limits: file.layer.limits, rules: file.layer.rules, problems: [] }));
	if (!rulesOnly) lines.push(...section("配置文件", table(fileRows([file]))));
	return info(lines.join("\n"));
}
function restriction(settings: Settings, state: RunState): string | undefined {
	if (settings.config.problems.length) return "配置无效，暂时无法自动恢复；详情见 /onward show。";
	if (!settings.config.enabled) return "当前自动恢复已停用。";
	if (!usable(settings.config)) return "当前没有可用规则，暂时不会自动恢复。";
	if (state.phase === "stopped") return "本轮恢复已停止，发消息开启新一轮。";
	return undefined;
}
function saveBlocker(saved: Saved): string | undefined {
	switch (saved.kind) {
		case "broken":
			return "配置文件无法读取";
		case "unbound":
			return "当前目录尚未确定";
		case "untrusted":
			return "项目未受信任";
		default:
			return undefined;
	}
}

export function toggleNotice(
	saved: Saved,
	settings: Settings,
	status: OnwardStatus,
	scope: Scope,
	enabled: boolean,
): Notice {
	const verb = enabled ? "启用" : "停用";
	const target = `${NAMES[scope]}配置`;
	const blocker = saveBlocker(saved);
	if (blocker) return warning(`onward：未能${verb}自动恢复（${target}）\n${blocker}，配置未修改。`);
	const lines = [
		saved.kind === "saved"
			? `onward：已${verb}自动恢复（${target}）`
			: `onward：${verb}设置保存失败（${target}）\n本次运行保留了配置修改；重新加载或重启后以原文件为准。`,
	];
	if (scope === "global" && settings.config.enabled !== enabled && settings.origin("enabled") === "project")
		lines.push(`当前项目仍${settings.config.enabled ? "启用" : "停用"}自动恢复：项目级配置覆盖了全局配置。`);
	else if (enabled) {
		const reason = restriction(settings, status.state);
		if (reason) lines.push(reason);
	}
	return saved.kind === "unwritten" || lines.length > 1 ? warning(lines.join("\n")) : info(lines.join("\n"));
}
export function changedNotice(
	saved: Saved,
	settings: Settings,
	status: OnwardStatus,
	change: { action: "set" | "unset" | "reset"; scope: Scope; keys: readonly string[] },
): Notice {
	const { action, scope, keys } = change;
	const label = action === "set" ? "修改配置参数" : action === "unset" ? "移除配置项" : "重置配置参数";
	const target = `${NAMES[scope]}配置`;
	const blocker = saveBlocker(saved);
	if (blocker)
		return warning(
			`onward：未能${label}（${target}）\n${blocker}，配置未修改。${action === "reset" ? "\n本轮恢复状态和计数已重置。" : ""}`,
		);
	const lines = [
		saved.kind === "saved"
			? `onward：已${label}（${target}）`
			: `onward：配置修改保存失败（${target}）\n本次运行保留了配置修改；重新加载或重启后以原文件为准。`,
	];
	if (action === "set") {
		const layer = settings.file(scope)!.layer;
		lines.push(
			...table(
				keys.map((key) => [key, key === "quietStartup" ? String(layer.quietStartup) : shown(key, layer.limits)]),
			),
		);
	} else if (action === "unset") {
		if (settings.config.problems.length) lines.push(`配置项：${keys.join("、")}`);
		else lines.push("当前采用", ...table(keys.map((key) => [key, effective(settings, key)])));
	} else lines.push("已移除开关、恢复上限和 quietStartup；rules 及其他手写内容未改动。");
	const covered = scope === "global" ? keys.filter((key) => settings.has("project", key)) : [];
	if (covered.length) lines.push(`当前项目的 ${covered.join("、")} 仍由项目级配置覆盖；详情见 /onward show。`);
	const reason = restriction(settings, status.state);
	if (reason) lines.push(reason);
	return saved.kind === "unwritten" || reason ? warning(lines.join("\n")) : info(lines.join("\n"));
}
export function reloadNotice(settings: Settings, status: OnwardStatus): Notice {
	const scopes = settings.files
		.filter((file) => file.source.kind !== "untrusted")
		.map((file) => NAMES[file.scope])
		.join("、");
	if (settings.config.problems.length)
		return warning(`onward：重新加载后配置无效（${scopes}）\n修好之前不会自动恢复，详情见 /onward show。`);
	const reason = restriction(settings, status.state);
	const ignored = settings.file("project")?.source.kind === "untrusted" ? "\n项目未受信任，未读取项目配置。" : "";
	return info(`onward：已重新加载配置（${scopes}）${ignored}${reason ? `\n${reason}` : ""}`);
}
export function startupNotice(settings: Settings, quiet: () => boolean, actionProblems: number): Notice | undefined {
	if (settings.config.problems.length)
		return warning(
			`🛑 onward：配置有 ${settings.config.problems.length} 处问题，修好之前不会自动恢复（/onward show 查看）`,
		);
	const notices: string[] = [];
	const warnings = configWarnings(settings.config);
	if (warnings.length) notices.push(`规则有 ${warnings.length} 处提醒（/onward show 查看）`);
	if (actionProblems) notices.push(`动作注册有 ${actionProblems} 处问题（/onward actions 查看）`);
	if (notices.length) return warning(`onward：${notices.join("；")}；不影响当前配置生效。`);
	const project = settings.file("project")?.source.kind === "file";
	const idle = settings.config.enabled && !usable(settings.config);
	if ((!project && !idle) || quiet()) return;
	return info(
		`${idle ? "💤 " : ""}onward：${project ? "用上了项目级设置；" : ""}${idle ? "没有可用的规则，出错时不会自动恢复" : "配置已加载"}（/onward show 查看）`,
	);
}
