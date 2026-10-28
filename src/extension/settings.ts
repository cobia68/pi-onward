/**
 * 设置文件 `onward.json` 的读写；放在哪里由 index.ts 决定。
 *
 * `rules` 只能手写；命令只改 `enabled` 和顶层的参数字段。每次写之前重读文件，在它当前的内容上合并，免得盖掉
 * 加载之后才手改的内容；文件读不了（不是合法 JSON、顶层不是对象）时拒绝写，让用户自己修。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, fileOrder, parseConfig } from "../policy/config.ts";
import { FIELD_NAMES } from "../policy/policy.ts";
import { errorText, isRecord } from "../util.ts";

/** 当前设置从哪里来。 */
export type Source = { kind: "file" | "none" } | { kind: "broken"; error: string };

/** 一次命令改了什么：`set` 是设置文件里的值，`unset` 是要去掉的键；没写的不动。 */
export interface SettingsChange {
	enabled?: boolean;
	set?: Record<string, unknown>;
	unset?: readonly string[];
}

/** 改动的结果：写好了；文件坏了，什么都没改；或者写不进去，这次运行仍按改过的设置走。 */
export type Saved =
	| { kind: "saved"; value: Record<string, unknown> }
	| { kind: "broken"; error: string }
	| { kind: "unwritten"; error: string };

/** reset 去掉的键：开关和顶层的参数。 */
const COMMAND_KEYS: readonly string[] = ["enabled", ...FIELD_NAMES];

interface Loaded {
	config: Config;
	source: Source;
}

export class Settings {
	readonly path: string;
	private loaded: Loaded;

	constructor(path: string) {
		this.path = path;
		this.loaded = load(path);
	}

	get config(): Config {
		return this.loaded.config;
	}

	get source(): Source {
		return this.loaded.source;
	}

	reload(): void {
		this.loaded = load(this.path);
	}

	/** 在文件当前的内容上合并后写回；文件坏了时不动它。 */
	update(change: SettingsChange): Saved {
		const current = readJson(this.path);
		if (current.kind === "broken") return current;
		const next = applyChange(current.kind === "ok" ? current.value : {}, change);
		this.loaded = { config: parseConfig(next), source: { kind: "file" } };
		try {
			writeJson(this.path, next);
		} catch (error: unknown) {
			return { kind: "unwritten", error: errorText(error) };
		}
		return { kind: "saved", value: next };
	}

	/** 去掉开关和顶层的参数，手写的 rules 和其他内容留着。 */
	reset(): Saved {
		return this.update({ unset: COMMAND_KEYS });
	}
}

function applyChange(base: Record<string, unknown>, change: SettingsChange): Record<string, unknown> {
	const next: Record<string, unknown> = { ...base, ...change.set };
	if (change.enabled !== undefined) next.enabled = change.enabled;
	for (const name of change.unset ?? []) delete next[name];
	return fileOrder(next);
}

function load(path: string): Loaded {
	const current = readJson(path);
	if (current.kind === "ok") return { config: parseConfig(current.value), source: { kind: "file" } };
	return { config: parseConfig(undefined), source: current.kind === "broken" ? current : { kind: "none" } };
}

type ReadResult =
	| { kind: "missing" }
	| { kind: "broken"; error: string }
	| { kind: "ok"; value: Record<string, unknown> };

function readJson(path: string): ReadResult {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "broken", error: errorText(error) };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error: unknown) {
		return { kind: "broken", error: `不是合法 JSON：${errorText(error)}` };
	}
	return isRecord(value) ? { kind: "ok", value } : { kind: "broken", error: "顶层需要是对象 {}" };
}

/** 先写临时文件再改名：写到一半失败也不会留下半个文件；改名之后临时文件已不在，删它不做事。 */
function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}
