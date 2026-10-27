/**
 * 设置文件 `<agent-dir>/onward.json` 的读写。
 *
 * `rules` 只能手写；命令只改 `enabled` 和 `defaults` 里这次动到的字段。每次写之前重读文件，
 * 在它当前的内容上合并，免得盖掉加载之后才手改的内容；文件不是合法 JSON 时拒绝写，让用户自己修。
 * `onward.json` 不存在时读旧版 `auto-continue.json`，第一次保存落到新文件，旧文件不删。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, migrateLegacy, parseConfig } from "../policy/config.ts";
import type { PolicyPatch } from "../policy/policy.ts";
import { errorText, isRecord } from "../util.ts";

/** 当前设置从哪里来。 */
export type Source = { kind: "file" | "legacy" | "none" } | { kind: "broken"; error: string };

/** 一次命令改了什么；没写的字段不动。 */
export interface SettingsChange {
	enabled?: boolean;
	patch: PolicyPatch;
}

interface Loaded {
	config: Config;
	source: Source;
}

/** 命令只管这两个键。 */
const COMMAND_KEYS = new Set(["enabled", "defaults"]);

export class Settings {
	readonly path: string;
	readonly legacyPath: string | undefined;
	private loaded: Loaded;

	constructor(path: string, legacyPath?: string) {
		this.path = path;
		this.legacyPath = legacyPath;
		this.loaded = load(path, legacyPath);
	}

	get config(): Config {
		return this.loaded.config;
	}

	get source(): Source {
		return this.loaded.source;
	}

	reload(): void {
		this.loaded = load(this.path, this.legacyPath);
	}

	/** 改动总是立即生效；写不进文件时抛出，这次运行仍按改过的设置走。 */
	update(change: SettingsChange): void {
		const current = readJson(this.path);
		const base =
			current.kind === "ok" && isRecord(current.value)
				? current.value
				: { enabled: this.config.enabled, defaults: this.config.defaults };
		const next = applyChange(base, change);
		const config = parseConfig(next);
		if (current.kind === "broken") {
			this.loaded = { ...this.loaded, config };
			throw new Error(`${this.path} 不是合法 JSON（${current.error}），先修好再改设置`);
		}
		this.loaded = { config, source: { kind: "file" } };
		writeJson(this.path, next);
	}

	/** 去掉命令管的键，手写的 rules 留着；只剩空壳就删文件。返回文件是否还在。 */
	reset(): boolean {
		const current = readJson(this.path);
		if (current.kind === "broken")
			throw new Error(`${this.path} 不是合法 JSON（${current.error}），先修好再恢复默认`);
		const entries = current.kind === "ok" && isRecord(current.value) ? Object.entries(current.value) : [];
		const rest = Object.fromEntries(entries.filter(([key]) => !COMMAND_KEYS.has(key)));
		const kept = Object.keys(rest).some((key) => key !== "$schema");
		if (kept) writeJson(this.path, rest);
		else rmSync(this.path, { force: true });
		this.reload();
		return kept;
	}
}

/** `PI_ONWARD_CONFIG` / `PI_AUTO_CONTINUE_CONFIG` 可改路径。 */
export function defaultPaths(env: NodeJS.ProcessEnv = process.env): { path: string; legacyPath: string } {
	const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return {
		path: env.PI_ONWARD_CONFIG || join(agentDir, "onward.json"),
		legacyPath: env.PI_AUTO_CONTINUE_CONFIG || join(agentDir, "auto-continue.json"),
	};
}

function applyChange(base: Record<string, unknown>, change: SettingsChange): Record<string, unknown> {
	const defaults = isRecord(base.defaults) ? base.defaults : {};
	return {
		...base,
		...(change.enabled === undefined ? {} : { enabled: change.enabled }),
		defaults: { ...defaults, ...change.patch },
	};
}

function load(path: string, legacyPath: string | undefined): Loaded {
	const current = readJson(path);
	if (current.kind === "ok") return { config: parseConfig(current.value), source: { kind: "file" } };
	if (current.kind === "broken")
		return { config: parseConfig(undefined), source: { kind: "broken", error: current.error } };
	const legacy = legacyPath === undefined ? undefined : readJson(legacyPath);
	if (legacy?.kind === "ok") return { config: migrateLegacy(legacy.value), source: { kind: "legacy" } };
	return { config: parseConfig(undefined), source: { kind: "none" } };
}

type ReadResult = { kind: "missing" } | { kind: "broken"; error: string } | { kind: "ok"; value: unknown };

function readJson(path: string): ReadResult {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "broken", error: errorText(error) };
	}
	try {
		return { kind: "ok", value: JSON.parse(text) };
	} catch (error: unknown) {
		return { kind: "broken", error: errorText(error) };
	}
}

/** 先写临时文件再改名：写到一半失败也不会留下半个文件。 */
function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	try {
		renameSync(temp, path);
	} catch (error: unknown) {
		rmSync(temp, { force: true });
		throw error;
	}
}
