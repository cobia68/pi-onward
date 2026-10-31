/**
 * pi-onward：一轮以错误收尾（401、429、502、Connection error. 等）、或者正常结束却是空回复时，按用户写的规则续跑。
 * 没有内置规则。
 *
 * - `policy/`：纯逻辑，不碰 pi 的运行时和文件。什么算失败、命中哪条规则、按什么参数、等多久、什么时候停。
 * - `extension/`：接 pi。`onward` 处理事件并续跑，`command` 是 `/onward`，`autocomplete` 让它的参数里按 Tab 补参数，
 *   `settings` 读写全局和项目级设置文件并合并，`text` 是给人看的文字，`render` 画会话里的续跑消息，`install` 把它们装起来。
 *
 * 这里是 pi 加载的入口，只决定设置文件的位置：
 * - 全局在 pi 自己的 getAgentDir() 里，`PI_CODING_AGENT_DIR` 的写法（包括 `~`）和 pi 一致。
 * - 项目级是当前目录下的 `.pi/onward.json`，不往上级目录找：pi 读 `.pi/settings.json` 也只看当前目录。
 */
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { install } from "./install.ts";
import type { ConfigPaths } from "./settings.ts";

export function configPaths(): ConfigPaths {
	return {
		global: join(getAgentDir(), "onward.json"),
		project: (cwd) => join(cwd, CONFIG_DIR_NAME, "onward.json"),
	};
}

export default function piOnward(pi: ExtensionAPI): void {
	install(pi, configPaths());
}
