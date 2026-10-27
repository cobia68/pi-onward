/** 什么算失败、什么算恢复，以及两次失败算不算「同一个错误」。 */

/** 以错误结束的助手消息里用得到的字段。 */
export interface Failure {
	role: "assistant";
	stopReason: "error";
	errorMessage?: string;
	provider?: string;
	model?: string;
}

/** 用户按 Esc 是 `aborted`，不算失败。 */
export function isFailure(message: unknown): message is Failure {
	const m = message as Partial<Failure> | undefined;
	return m?.role === "assistant" && m.stopReason === "error";
}

const SUCCESS = new Set(["stop", "length", "toolUse", "deferred"]);

/** 助手正常返回了一次（包括中间的工具轮），说明已经恢复。 */
export function isSuccess(message: unknown): boolean {
	const m = message as { role?: unknown; stopReason?: unknown } | undefined;
	return m?.role === "assistant" && SUCCESS.has(m.stopReason as string);
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
