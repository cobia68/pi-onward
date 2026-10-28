/** 把各部分装到 pi 上。设置文件放在哪由调用方给：入口是 index.ts，测试直接给临时路径。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { argumentTabCompletion } from "./autocomplete.ts";
import { registerCommand } from "./command.ts";
import { Onward } from "./onward.ts";
import { Settings } from "./settings.ts";
import { say, startupNotices } from "./text.ts";

export function install(pi: ExtensionAPI, configPath: string): void {
	const settings = new Settings(configPath);
	const onward = new Onward(settings);

	pi.on("session_start", (_event, ctx) => {
		// reload 和切换会话时 pi 会清掉扩展装的补全，所以每次都装。
		ctx.ui.addAutocompleteProvider(argumentTabCompletion);
		for (const notice of startupNotices(settings)) say(ctx, notice);
	});
	pi.on("agent_start", (_event, ctx) => onward.agentStart(ctx));
	pi.on("message_end", (event, ctx) => onward.messageEnd(event, ctx));
	pi.on("agent_before_settle", (event, ctx) => onward.beforeSettle(event, ctx));
	pi.on("agent_settled", (_event, ctx) => onward.settled(ctx));
	pi.on("session_shutdown", (_event, ctx) => onward.shutdown(ctx));

	registerCommand(pi, settings, onward);
}
