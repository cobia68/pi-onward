/**
 * pi-onward：一轮以错误收尾（401、429、502、Connection error. 等）时，按用户写的规则续跑。没有内置规则。
 *
 * - `policy/`：纯逻辑，不碰 pi 和文件。什么算失败、命中哪条规则、按什么参数、等多久、什么时候停。
 * - `extension/`：接 pi。`onward` 处理事件并续跑，`command` 是 `/onward`，`settings` 读写设置文件，`text` 是给人看的文字。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "./command.ts";
import { Onward } from "./onward.ts";
import { defaultPath, Settings } from "./settings.ts";
import { say, startupNotices } from "./text.ts";

export interface OnwardOptions {
	configPath?: string;
}

export default function piOnward(pi: ExtensionAPI): void {
	install(pi);
}

export function install(pi: ExtensionAPI, options: OnwardOptions = {}): void {
	const settings = new Settings(options.configPath ?? defaultPath());
	const onward = new Onward(settings);

	pi.on("session_start", (_event, ctx) => {
		for (const notice of startupNotices(settings)) say(ctx, notice);
	});
	pi.on("agent_start", (_event, ctx) => onward.agentStart(ctx));
	pi.on("message_end", (event, ctx) => onward.messageEnd(event, ctx));
	pi.on("agent_before_settle", (event, ctx) => onward.beforeSettle(event, ctx));
	pi.on("agent_settled", (_event, ctx) => onward.settled(ctx));
	pi.on("session_shutdown", (_event, ctx) => onward.shutdown(ctx));

	registerCommand(pi, settings, onward);
}
