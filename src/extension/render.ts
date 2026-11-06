/** 避免 Pi 默认添加 [pi-onward] 标题，续跑消息只显示正文。 */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const renderContinue: MessageRenderer = (message, { outputPad }, theme) => {
	const body =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const lines = body.split("\n").map((line) => theme.fg("customMessageText", line));
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
};
