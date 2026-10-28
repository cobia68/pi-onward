/**
 * 续跑消息在会话里的样子：第一行是标签「⏩ onward · 续跑 2/10 · auth」，下面是发给模型的原文。
 * 没有这个渲染器时 pi 画成「[pi-onward]」加原文，看不出是第几次、哪条规则；恢复会话时通知不会重放，
 * 只有这条消息还在。模型只读到原文，标签不进上下文。
 */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { continueLabel } from "./text.ts";

export const renderContinue: MessageRenderer = (message, { outputPad }, theme) => {
	const body =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const lines = [
		theme.fg("customMessageLabel", theme.bold(continueLabel(message.details))),
		...body.split("\n").map((line) => theme.fg("customMessageText", line)),
	];
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
};
