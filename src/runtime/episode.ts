/** One recovery episode, independent of rule changes. Only confirmed boundary failures advance it. */
import { randomUUID } from "node:crypto";
import type { RecoveryChain } from "../actions/protocol.ts";
export class Episode {
	id = randomUUID();
	failures = 0;
	started = 0;
	chain: RecoveryChain;
	private seen = new Set<string>();
	constructor(maxHandoffs: number) {
		this.chain = { id: randomUUID(), handoffs: 0, maxHandoffs };
	}
	observe(entryId: string): boolean {
		if (this.seen.has(entryId)) return false;
		this.seen.add(entryId);
		this.failures++;
		return true;
	}
}
