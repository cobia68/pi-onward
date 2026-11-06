import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CUSTOM_TYPE } from "../actions/builtins.ts";
import { Recovery } from "../runtime/recovery.ts";
import { argumentTabCompletion } from "./autocomplete.ts";
import { registerCommand } from "./command.ts";
import { renderContinue } from "./render.ts";
import { type ConfigPaths, Settings } from "./settings.ts";
import { say, startupNotice } from "./text.ts";

export function install(pi: ExtensionAPI, paths: ConfigPaths): void {
	const settings = new Settings(paths);
	const onward = new Recovery(pi, settings);

	pi.on("session_start", (_event, ctx) => {
		// pi 到这时才定下当前目录，项目级设置从这里开始读。
		settings.bind(ctx.cwd, () => ctx.isProjectTrusted());
		onward.start(ctx);
		// reload 和切换会话时 pi 会清掉扩展装的补全，所以每次都装。
		ctx.ui.addAutocompleteProvider(argumentTabCompletion);
		const notice = startupNotice(settings, () => quietStartup(pi, settings), onward.registry.diagnostics.length);
		if (notice) say(ctx, notice);
	});
	pi.on("input", (event, ctx) => onward.input(event, ctx));
	pi.on("session_tree", (_event, ctx) => onward.branch(ctx));
	pi.on("agent_start", (_event, ctx) => onward.agentStart(ctx));
	pi.on("message_end", (event, ctx) => onward.messageEnd(event, ctx));
	pi.on("agent_before_settle", (event, ctx) => onward.beforeSettle(event, ctx));
	pi.on("agent_settled", (event, ctx) => onward.settled(event, ctx));
	pi.on("session_shutdown", (_event, ctx) => onward.shutdown(ctx));

	registerCommand(pi, settings, onward);
	pi.registerMessageRenderer(CUSTOM_TYPE, renderContinue);
}

function quietStartup(pi: ExtensionAPI, settings: Settings): boolean {
	const own = settings.config.quietStartup;
	if (own !== undefined) return own;
	const fromPi = pi.getSettings().quietStartup;
	return fromPi === true || fromPi === "header";
}
