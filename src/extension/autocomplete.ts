import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import { COMMAND } from "./text.ts";

export function isArgumentTab(lines: string[], cursorLine: number, cursorCol: number): boolean {
	return cursorLine === 0 && (lines[0] ?? "").slice(0, cursorCol).trimStart().startsWith(`/${COMMAND} `);
}

/** Pi 的 Tab 默认补文件且忽略命令后的空参数；此处强制补参数。 */
export const argumentTabCompletion: AutocompleteProviderFactory = (current) => ({
	getSuggestions: (lines, cursorLine, cursorCol, options) =>
		current.getSuggestions(lines, cursorLine, cursorCol, {
			...options,
			force: options.force && !isArgumentTab(lines, cursorLine, cursorCol),
		}),
	applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
		current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
	shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
		isArgumentTab(lines, cursorLine, cursorCol) ||
		(current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true),
	...(current.triggerCharacters && { triggerCharacters: current.triggerCharacters }),
});
