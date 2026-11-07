/** Resolve consumed input origins and rebuild task text from records on the current branch. */
import type { BeforeAgentStartEvent, InputEvent, MessageEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../util.ts";

export const INPUT_RECORD = "onward.input";
type InputOrigin = "user" | "extension";
type UserMessage = Extract<MessageEndEvent["message"], { role: "user" }>;

export class TaskPrompt {
	value: string | undefined;
	private nextRun: InputOrigin[] = [];
	private starting: { source: InputOrigin | undefined } | undefined;
	private queued: InputOrigin[] = [];

	observe(event: InputEvent): void {
		// Later input handlers may transform or handle it. Observation alone never changes a task.
		const candidates = event.streamingBehavior === undefined ? this.nextRun : this.queued;
		candidates.push(event.source === "extension" ? "extension" : "user");
	}
	begin(event: BeforeAgentStartEvent): void {
		if (event.messageType !== "user") return;
		this.starting = { source: commonOrigin(this.nextRun) };
		this.nextRun = [];
	}
	consume(): InputOrigin | undefined {
		if (this.starting) {
			const { source } = this.starting;
			this.starting = undefined;
			return source;
		}
		const source = commonOrigin(this.queued);
		if (source !== undefined) this.queued.shift();
		return source;
	}
	clearPending(): void {
		this.nextRun = [];
		this.starting = undefined;
		this.queued = [];
	}
	restore(branch: readonly SessionEntry[]): void {
		this.clearPending();
		this.refresh(branch);
	}
	refresh(branch: readonly SessionEntry[]): void {
		this.value = undefined;
		let hasUser = false;
		let record: { timestamp: number; source: InputOrigin | undefined } | undefined;
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === INPUT_RECORD) {
				const data = entry.data;
				record =
					isRecord(data) && typeof data.timestamp === "number"
						? { timestamp: data.timestamp, source: inputOrigin(data.source) }
						: undefined;
			} else if (entry.type === "message" && entry.message.role === "user") {
				// message_end appends the record just before Pi persists its user message. A branch cut
				// before that message must not adopt the dangling record as its task.
				const source = record && record.timestamp === entry.message.timestamp ? record.source : undefined;
				if (source === undefined) this.value = undefined;
				else if (source === "user" || !hasUser) this.value = userText(entry.message);
				hasUser = true;
				record = undefined;
			}
		}
	}
}
function inputOrigin(value: unknown): InputOrigin | undefined {
	return value === "user" || value === "extension" ? value : undefined;
}
function commonOrigin(candidates: readonly InputOrigin[]): InputOrigin | undefined {
	// Pi does not expose an accepted-input ID or a source on user messages. Text equality cannot
	// prove origin after transforms/handled inputs. Mixed origins stay unknown until settlement.
	return candidates.every((source) => source === candidates[0]) ? candidates[0] : undefined;
}
function userText(message: UserMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}
