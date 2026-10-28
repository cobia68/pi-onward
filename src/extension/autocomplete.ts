/** `/onward` 的参数里按 Tab：补参数，不补文件名。 */
import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import { COMMAND } from "./text.ts";

/** 光标在 `/onward` 的参数里：和 pi 一样只看第一行，命令名到空格为止。 */
export function isArgumentTab(lines: string[], cursorLine: number, cursorCol: number): boolean {
	return cursorLine === 0 && (lines[0] ?? "").slice(0, cursorCol).trimStart().startsWith(`/${COMMAND} `);
}

/** pi 把参数里的 Tab 当成文件补全，紧跟在「/onward 」后面的 Tab 直接丢掉；在 `/onward` 的参数里都改成补参数。 */
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
