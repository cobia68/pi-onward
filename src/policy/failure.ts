import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";

export type AgentMessage = MessageEndEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export type ErrorReply = AssistantMessage & { stopReason: "error" };

/** 正常结束但无文字、无工具调用；思考与空白不算输出。 */
export type EmptyReply = AssistantMessage & { stopReason: "stop" };

export type Failure = ErrorReply | EmptyReply;

/** 用户按 Esc 是 `aborted`，不算失败。 */
export function isError(message: AgentMessage | undefined): message is ErrorReply {
	return message?.role === "assistant" && message.stopReason === "error";
}

export function isEmptyReply(message: AgentMessage | undefined): message is EmptyReply {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	return !message.content.some(
		(part) => part.type === "toolCall" || (part.type === "text" && part.text.trim() !== ""),
	);
}

export function isFailure(message: AgentMessage | undefined): message is Failure {
	return isError(message) || isEmptyReply(message);
}

/** 匹配文本：空回复用空串，缺少文案的错误用非空占位；其余保留原文。 */
export function failureText(failure: Failure): string {
	if (failure.stopReason === "stop") return "";
	const text = failure.errorMessage ?? "";
	return text.trim() ? text : UNKNOWN_ERROR;
}

const SUCCESS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["stop", "length", "toolUse", "deferred"]);

/** 正常回复（包括工具轮）结束恢复；空回复不算成功。 */
export function isSuccess(message: AgentMessage): boolean {
	return message.role === "assistant" && SUCCESS.has(message.stopReason) && !isEmptyReply(message);
}

const UNKNOWN_ERROR = "未知错误";
