/** 只读写全局和受信任的项目配置；未保存修改与磁盘快照分离。 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, type ConfigLayer, fileOrder, mergeLayers, parseLayer } from "../policy/config.ts";
import { FIELD_NAMES } from "../policy/policy.ts";
import { errorText, isRecord } from "../util.ts";

export const SCOPES = ["global", "project"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ConfigPaths {
	global: string;
	project(cwd: string): string;
}

/** 文件的读取状态；未受信任时不探测文件是否存在，也不读取内容。 */
export type Source = { kind: "file" | "none" | "untrusted" } | { kind: "broken"; error: string };

export interface SettingsFile {
	scope: Scope;
	path: string;
	source: Source;
	/** 未保存的键，包含待删除的字段。 */
	unsaved: readonly string[];
	/** 读取失败时为空层并携带错误，阻止合并配置部分生效。 */
	layer: ConfigLayer;
}

export interface SettingsChange {
	enabled?: boolean;
	set?: Record<string, unknown>;
	unset?: readonly string[];
}

/** unwritten 表示修改已保留在内存，尚未落盘。 */
export type Saved =
	| { kind: "saved"; value: Record<string, unknown> }
	| { kind: "broken"; path: string; error: string }
	| { kind: "unbound" | "untrusted" }
	| { kind: "unwritten"; error: string };

/** reset 仅清除这些键，保留手写规则。 */
export const COMMAND_KEYS: readonly string[] = ["enabled", ...FIELD_NAMES, "quietStartup"];

const EMPTY: ConfigLayer = { limits: {}, problems: [] };

export class Settings {
	private readonly paths: ConfigPaths;
	/** 项目绑定只活在当前会话；重载和写入时向 Pi 重新查询信任状态。 */
	private project: { path: string; isTrusted: () => boolean } | undefined;
	/** undefined 值表示删除键；记录操作而不是整份文件，才能保留后续手工编辑。 */
	private unsaved = new Map<Scope, Record<string, unknown>>();
	private loaded!: { global: SettingsFile; project?: SettingsFile };
	private merged!: Config;
	private validateActions: ((config: Config) => string[]) | undefined;

	setActionValidator(validate: (config: Config) => string[]): void {
		this.validateActions = validate;
		this.remerge();
	}

	constructor(paths: ConfigPaths) {
		this.paths = paths;
		this.reload();
	}

	bind(cwd: string, isTrusted: () => boolean): void {
		this.project = { path: this.paths.project(cwd), isTrusted };
		this.reload();
	}

	get config(): Config {
		return this.merged;
	}

	/** 全局在前、项目在后；会话绑定前只有全局。 */
	get files(): readonly SettingsFile[] {
		const { project } = this.loaded;
		return project ? [this.loaded.global, project] : [this.loaded.global];
	}

	file(scope: "global"): SettingsFile;
	file(scope: Scope): SettingsFile | undefined;
	file(scope: Scope): SettingsFile | undefined {
		return this.loaded[scope];
	}

	/** 显式重载丢弃未保存修改。 */
	reload(): void {
		this.unsaved.clear();
		this.refresh();
	}

	private refresh(): void {
		const global = readFile("global", this.paths.global, this.unsaved.get("global"));
		const project = this.project;
		this.loaded = { global };
		if (project)
			this.loaded.project = project.isTrusted()
				? readFile("project", project.path, this.unsaved.get("project"))
				: { scope: "project", path: project.path, source: { kind: "untrusted" }, unsaved: [], layer: EMPTY };
		this.remerge();
	}

	/** 写前重读以保留手工编辑；空内容不新建文件，避免无意义的项目提示。 */
	update(scope: Scope, change: SettingsChange): Saved {
		const path = this.pathOf(scope);
		if (path === undefined) return { kind: "unbound" };
		if (scope === "project" && !this.project!.isTrusted()) return { kind: "untrusted" };
		const current = readJson(path);
		if (current.kind === "broken") return { kind: "broken", path, error: current.error };
		const patch = mergeChange(this.unsaved.get(scope), change);
		const next = applyPatch(current.kind === "ok" ? current.value : {}, patch);
		this.unsaved.set(scope, patch);
		let saved: Saved;
		try {
			if (current.kind !== "missing" || Object.keys(next).length > 0) writeJson(path, next);
			this.unsaved.delete(scope);
			saved = { kind: "saved", value: next };
		} catch (error: unknown) {
			saved = { kind: "unwritten", error: errorText(error) };
		}
		// 重读磁盘，但重新叠加每一层尚未保存的字段，不能隐式执行 reload。
		this.refresh();
		return saved;
	}

	reset(scope: Scope): Saved {
		return this.update(scope, { unset: COMMAND_KEYS });
	}

	/** 非法标量不算已配置；非法 rules 仍算显式覆盖，但会阻断配置生效。 */
	has(scope: Scope, key: string): boolean {
		const layer = this.loaded[scope]?.layer;
		if (!layer) return false;
		if (key === "enabled") return layer.enabled !== undefined;
		if (key === "quietStartup") return layer.quietStartup !== undefined;
		if (key === "rules") return layer.rules !== undefined;
		return Object.hasOwn(layer.limits, key);
	}

	/** 没有可用的显式值时返回 undefined。 */
	origin(key: string): Scope | undefined {
		return (["project", "global"] as const).find((scope) => this.has(scope, key));
	}

	private pathOf(scope: Scope): string | undefined {
		return scope === "global" ? this.paths.global : this.project?.path;
	}

	private remerge(): void {
		this.merged = mergeLayers(this.files.map((file) => file.layer));
		if (!this.merged.problems.length && this.validateActions)
			this.merged.problems.push(...this.validateActions(this.merged));
	}
}

function readFile(scope: Scope, path: string, patch?: Record<string, unknown>): SettingsFile {
	const current = readJson(path);
	const file = { scope, path, unsaved: Object.keys(patch ?? {}) };
	if (current.kind === "broken") return { ...file, source: current, layer: { ...EMPTY, problems: [current.error] } };
	return {
		...file,
		source: { kind: current.kind === "ok" ? "file" : "none" },
		layer: parseLayer(applyPatch(current.kind === "ok" ? current.value : {}, patch), scope === "project"),
	};
}

function mergeChange(previous: Record<string, unknown> | undefined, change: SettingsChange): Record<string, unknown> {
	const patch = { ...previous, ...change.set };
	if (change.enabled !== undefined) patch.enabled = change.enabled;
	for (const name of change.unset ?? []) patch[name] = undefined;
	return patch;
}

function applyPatch(base: Record<string, unknown>, patch?: Record<string, unknown>): Record<string, unknown> {
	const next = { ...base };
	for (const [name, value] of Object.entries(patch ?? {})) {
		if (value === undefined) delete next[name];
		else next[name] = value;
	}
	return fileOrder(next);
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
		return { kind: "broken", error: `Invalid JSON: ${errorText(error)}` };
	}
	return isRecord(value)
		? { kind: "ok", value }
		: { kind: "broken", error: "Top-level configuration must be a JSON object" };
}

/** 临时文件写完再原子改名，避免留下半写的配置。 */
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
