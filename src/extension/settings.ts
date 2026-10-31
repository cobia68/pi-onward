/**
 * 设置文件 `onward.json` 的读写：全局一份，项目级一份（`.pi/onward.json`），放在哪里由 index.ts 决定。
 * 两份按 config.ts 的规则合并，项目级在后：顶层字段逐个覆盖全局，写了 `rules` 就整份替换全局的。
 *
 * 项目级要等 `session_start` 才知道：pi 那时才定下当前目录。不看 pi 对项目的信任：有这个文件就读，和它旁边有没有
 * `.pi/settings.json` 无关。
 *
 * `rules` 只能手写；命令只改 `enabled` 和顶层的参数字段，改哪一份由 `--scope` 定，不写就是全局。每次写之前重读
 * 要改的那份，在它当前的内容上合并，免得盖掉加载之后才手改的内容；文件读不了（不是合法 JSON、顶层不是对象）
 * 时拒绝写，让用户自己修。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, type ConfigLayer, fileOrder, mergeLayers, parseLayer } from "../policy/config.ts";
import { FIELD_NAMES } from "../policy/policy.ts";
import { errorText, isRecord } from "../util.ts";

/** 哪一份设置文件，也是 `--scope` 的取值；合并时后面的覆盖前面的。 */
export const SCOPES = ["global", "project"] as const;
export type Scope = (typeof SCOPES)[number];

/** 两份设置文件在哪：全局是固定的路径；项目级跟着当前目录走。 */
export interface ConfigPaths {
	global: string;
	project(cwd: string): string;
}

/** 一份设置文件的情况：读到了、还没有、读不了。 */
export type Source = { kind: "file" | "none" } | { kind: "broken"; error: string };

export interface SettingsFile {
	scope: Scope;
	path: string;
	source: Source;
	/** 读出来的内容；没有或读不了时是空的一层。读不了时带一条问题，让整份设置不生效；给人看的是 source 里的原因。 */
	layer: ConfigLayer;
}

/** 一次命令改了什么：`set` 是设置文件里的值，`unset` 是要去掉的键；没写的不动。 */
export interface SettingsChange {
	enabled?: boolean;
	set?: Record<string, unknown>;
	unset?: readonly string[];
}

/**
 * 改动的结果：写好了（要写的是空对象、文件又不在时不建文件，也算写好）；文件坏了，什么都没改；还不知道当前目录，
 * 项目级没法写；或者写不进去，这次运行仍按改过的设置走。
 */
export type Saved =
	| { kind: "saved"; value: Record<string, unknown> }
	| { kind: "broken"; path: string; error: string }
	| { kind: "unbound" }
	| { kind: "unwritten"; error: string };

/** reset 去掉的键：开关和顶层的参数。 */
export const COMMAND_KEYS: readonly string[] = ["enabled", ...FIELD_NAMES];

const EMPTY: ConfigLayer = { defaults: {}, problems: [] };

export class Settings {
	private readonly paths: ConfigPaths;
	/** 项目级在哪；`session_start` 之前是 undefined，只看全局。 */
	private projectPath: string | undefined;
	private loaded!: { global: SettingsFile; project?: SettingsFile };
	private merged!: Config;

	constructor(paths: ConfigPaths) {
		this.paths = paths;
		this.reload();
	}

	/** 当前目录定下来了：`session_start` 时调用，重新读两份。 */
	bind(cwd: string): void {
		this.projectPath = this.paths.project(cwd);
		this.reload();
	}

	/** 合并之后的设置。 */
	get config(): Config {
		return this.merged;
	}

	/** 参与合并的文件，全局在前；`session_start` 之前只有全局。 */
	get files(): readonly SettingsFile[] {
		const { project } = this.loaded;
		return project ? [this.loaded.global, project] : [this.loaded.global];
	}

	/** 全局总是有；项目级在 `session_start` 之前是 undefined。 */
	file(scope: "global"): SettingsFile;
	file(scope: Scope): SettingsFile | undefined;
	file(scope: Scope): SettingsFile | undefined {
		return this.loaded[scope];
	}

	/** 在用的项目级文件：读到了，或者读不了；没有这个文件时是 undefined。 */
	get projectFile(): SettingsFile | undefined {
		const { project } = this.loaded;
		return project?.source.kind === "none" ? undefined : project;
	}

	reload(): void {
		const global = readFile("global", this.paths.global);
		const project = this.projectPath === undefined ? undefined : readFile("project", this.projectPath);
		this.loaded = project ? { global, project } : { global };
		this.remerge();
	}

	/**
	 * 在要改的那份当前的内容上合并后写回；文件坏了时不动它。文件不在、改完又是空的（去掉本来就没有的参数），
	 * 不建文件：一份空的项目级设置什么都不改，却会让每次启动都提醒「用上了项目级设置」。
	 */
	update(scope: Scope, change: SettingsChange): Saved {
		const path = this.pathOf(scope);
		if (path === undefined) return { kind: "unbound" };
		const current = readJson(path);
		if (current.kind === "broken") return { kind: "broken", path, error: current.error };
		const next = applyChange(current.kind === "ok" ? current.value : {}, change);
		// 两份都重读：显示的状态和磁盘上的一致。
		this.reload();
		if (current.kind === "missing" && Object.keys(next).length === 0) return { kind: "saved", value: next };
		this.loaded[scope] = { scope, path, source: { kind: "file" }, layer: parseLayer(next) };
		this.remerge();
		try {
			writeJson(path, next);
		} catch (error: unknown) {
			return { kind: "unwritten", error: errorText(error) };
		}
		return { kind: "saved", value: next };
	}

	/** 去掉开关和顶层的参数，手写的 rules 和其他内容留着。 */
	reset(scope: Scope): Saved {
		return this.update(scope, { unset: COMMAND_KEYS });
	}

	/**
	 * 这份文件写了这个开关、参数或 `rules`。读不懂的开关和参数不算；写坏了的 `rules` 算写了，反正有问题时整份不生效。
	 */
	has(scope: Scope, key: string): boolean {
		const layer = this.loaded[scope]?.layer;
		if (!layer) return false;
		if (key === "enabled") return layer.enabled !== undefined;
		if (key === "rules") return layer.rules !== undefined;
		return Object.hasOwn(layer.defaults, key);
	}

	/** 这个开关、参数或 `rules` 来自哪一份：项目级优先；都没写时是 undefined，用内置默认值。 */
	origin(key: string): Scope | undefined {
		return (["project", "global"] as const).find((scope) => this.has(scope, key));
	}

	private pathOf(scope: Scope): string | undefined {
		return scope === "global" ? this.paths.global : this.projectPath;
	}

	private remerge(): void {
		this.merged = mergeLayers(this.files.map((file) => file.layer));
	}
}

function readFile(scope: Scope, path: string): SettingsFile {
	const current = readJson(path);
	switch (current.kind) {
		case "ok":
			return { scope, path, source: { kind: "file" }, layer: parseLayer(current.value) };
		case "missing":
			return { scope, path, source: { kind: "none" }, layer: EMPTY };
		case "broken":
			return { scope, path, source: current, layer: { ...EMPTY, problems: [current.error] } };
	}
}

function applyChange(base: Record<string, unknown>, change: SettingsChange): Record<string, unknown> {
	const next: Record<string, unknown> = { ...base, ...change.set };
	if (change.enabled !== undefined) next.enabled = change.enabled;
	for (const name of change.unset ?? []) delete next[name];
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
