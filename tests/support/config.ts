/** 测试里只看一份设置文件时用：和 Settings 一样先读成一层再合并。`raw` 是 undefined 表示没有这份文件。 */
import { type Config, mergeLayers, parseLayer } from "../../src/policy/config.ts";

export function parseConfig(raw: Record<string, unknown> | undefined): Config {
	return mergeLayers(raw === undefined ? [] : [parseLayer(raw)]);
}
