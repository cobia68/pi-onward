/**
 * pi-onward：一轮以错误收尾（401、429、502、Connection error. 等）时，按用户写的规则续跑。没有内置规则。
 *
 * - `policy/`：纯逻辑，不碰 pi 和文件。什么算失败、命中哪条规则、按什么参数、等多久、什么时候停。
 * - `extension/`：接 pi。`onward` 处理事件并续跑，`command` 是 `/onward`，`settings` 读写设置文件，`text` 是给人看的文字。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "./command.ts";
import { Onward } from "./onward.ts";
import { defaultPaths, Settings } from "./settings.ts";
import { LEGACY_COMMAND, say, startupNotices } from "./text.ts";

export interface OnwardOptions {
	configPath?: string;
	/** 旧版 `auto-continue.json`；传 false 不读。 */
	legacyPath?: string | false;
}

export default function piOnward(pi: ExtensionAPI): void {
	install(pi);
}

export function install(pi: ExtensionAPI, options: OnwardOptions = {}): void {
	const defaults = defaultPaths();
	const legacyPath = options.legacyPath === false ? undefined : (options.legacyPath ?? defaults.legacyPath);
	const settings = new Settings(options.configPath ?? defaults.path, legacyPath);
	const onward = new Onward(settings);

	pi.on("session_start", (_event, ctx) => {
		const legacyInstalled = pi.getCommands().some((command) => command.name === LEGACY_COMMAND);
		for (const notice of startupNotices(settings, legacyInstalled)) say(ctx, notice);
	});
	pi.on("agent_start", (_event, ctx) => onward.agentStart(ctx));
	pi.on("message_end", (event, ctx) => onward.messageEnd(event, ctx));
	pi.on("agent_before_settle", (event, ctx) => onward.beforeSettle(event, ctx));
	pi.on("agent_settled", () => onward.settled());
	pi.on("session_shutdown", (_event, ctx) => onward.shutdown(ctx));

	registerCommand(pi, settings, onward);
}
