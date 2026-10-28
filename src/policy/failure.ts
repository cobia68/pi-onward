/** 什么算失败、什么算恢复，以及两次失败算不算「同一个错误」。 */
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";

/** pi 的会话消息；只取类型，运行时不碰 pi。 */
export type AgentMessage = MessageEndEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** 以错误结束的助手消息。provider、model 是 pi 必填的；errorMessage 可能没有。 */
export type Failure = AssistantMessage & { stopReason: "error" };

/** 用户按 Esc 是 `aborted`，不算失败。 */
export function isFailure(message: AgentMessage | undefined): message is Failure {
	return message?.role === "assistant" && message.stopReason === "error";
}

const SUCCESS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["stop", "length", "toolUse", "deferred"]);

/** 助手正常返回了一次（包括中间的工具轮），说明已经恢复。 */
export function isSuccess(message: AgentMessage): boolean {
	return message.role === "assistant" && SUCCESS.has(message.stopReason);
}

/**
 * 中转常把 request id、UUID、时间戳、长十六进制串塞进错误文案，每次都不一样；
 * 不抹掉的话同一个错误永远只出现一次，同错上限就触发不了。
 */
export function normalizeError(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.replace(/request[\s_-]*id\s*[:=]?\s*[^\s,;)]+/g, "request-id")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "uuid")
		.replace(/\b\d{10,}\b/g, "num")
		.replace(/\b(?=[0-9a-f]{12,}\b)[0-9a-f]*[a-f][0-9a-f]*\b/g, "id");
}

export function errorSignature(failure: Failure): string {
	return normalizeError(failure.errorMessage ?? "") || "未知错误";
}
