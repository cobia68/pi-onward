/** 路径跟随 Pi；项目配置不向上查找。 */
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
