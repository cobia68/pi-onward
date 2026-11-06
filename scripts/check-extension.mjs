// Real Pi loader contract, isolated from all personal configuration and credentials.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { createExtensionRuntime, loadExtensions } = await import(
	pathToFileURL(resolve(sdk, "core/extensions/loader.js")).href
);
const scratch = mkdtempSync(join(tmpdir(), "onward-loader-"));
process.env.PI_CODING_AGENT_DIR = scratch;
try {
	writeFileSync(
		join(scratch, "onward.json"),
		JSON.stringify({
			rules: [
				{
					name: "server",
					stages: [
						{ minFailures: 1, action: { use: "onward.resend" } },
						{ minFailures: 3, action: { use: "onward.command", with: { name: "fixture", args: "opaque args" } } },
					],
				},
			],
		}),
	);
	const entryPath = resolve(root, manifest.pi.extensions[0]);
	const calls = [],
		notes = [],
		statuses = [],
		deferred = [];
	const runtime = createExtensionRuntime();
	runtime.getSettings = () => ({ quietStartup: true });
	runtime.getCommands = () =>
		["onward", "fixture"].map((name) => ({
			name,
			source: "extension",
			sourceInfo: {
				path: name === "onward" ? entryPath : "fixture.ts",
				source: "test",
				origin: "top-level",
				scope: "temporary",
			},
		}));
	runtime.appendEntry = () => {};
	runtime.sendUserMessage = (text, options) => {
		assert.equal(options.expandPromptTemplates, true);
		deferred.push(text);
	};
	const loaded = await loadExtensions([entryPath], scratch, undefined, runtime);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const command = extension.commands.get("onward");
	assert.ok(command);
	let trusted = true;
	const ctx = {
		cwd: scratch,
		isProjectTrusted: () => trusted,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		sessionManager: { getSessionId: () => "loader-session", getBranch: () => [] },
		ui: {
			notify: (message) => notes.push(message),
			addAutocompleteProvider: () => {},
			setStatus: (_key, text) => statuses.push(text),
		},
	};
	const emit = async (event, payload = {}) => {
		let result;
		for (const handler of extension.handlers.get(event) ?? [])
			result = await handler({ type: event, ...payload }, ctx);
		return result;
	};
	await emit("session_start", { reason: "startup" });
	await command.handler("actions", ctx);
	assert.match(notes.at(-1), /onward.command/);
	await command.handler("show", ctx);
	assert.match(notes.at(-1), /从第 3 次失败：onward.command/);
	for (let failure = 1; failure <= 3; failure++) {
		const message = {
			role: "assistant",
			stopReason: "error",
			errorMessage: "502",
			provider: "test",
			model: "test",
			content: [],
		};
		const result = await emit("agent_before_settle", {
			outcome: "error",
			entries: [],
			continue: false,
			context: { contextEntries: [{ sourceEntry: { id: `e${failure}` }, messages: [message] }] },
		});
		if (failure < 3) {
			assert.equal(result.continue, true);
			assert.equal(result.entries[0].targetId, `e${failure}`);
			await emit("agent_start");
		} else assert.equal(result, undefined);
	}
	assert.equal(deferred.length, 0);
	await emit("agent_settled", { aborted: false });
	assert.equal(deferred.length, 1);
	await command.handler(deferred.shift().slice("/onward ".length), ctx);
	calls.push(deferred.shift());
	assert.deepEqual(calls, ["/fixture opaque args"]);
	await command.handler("status", ctx);
	assert.match(notes.at(-1), /连续失败\s+3 次[\s\S]*已分派，业务结果未知/);
	assert.ok(extension.messageRenderers.has("pi-onward"));
	assert.ok(statuses.some((value) => value?.includes("onward.command")));
	writeFileSync(
		join(scratch, "onward.json"),
		JSON.stringify({
			rules: [
				{ stages: [{ minFailures: 1, action: { use: "onward.message", with: { prompt: "继续{taskPrompt}" } } }] },
			],
		}),
	);
	await command.handler("reload", ctx);
	await emit("input", { source: "rpc", text: "检查 {error} 和 $&" });
	for (let failure = 1; failure <= 2; failure++) {
		const result = await emit("agent_before_settle", {
			outcome: "error",
			entries: [],
			continue: false,
			context: {
				contextEntries: [
					{
						sourceEntry: { id: `template-${failure}` },
						messages: [{ role: "assistant", stopReason: "error", errorMessage: "502", content: [] }],
					},
				],
			},
		});
		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 1);
		assert.equal(result.entries[0].type, "custom_message");
		assert.equal(result.entries[0].content, "继续检查 {error} 和 $&");
		await emit("agent_start");
	}
	// A declined project must not override global rules or dispatch an extension command.
	mkdirSync(join(scratch, ".pi"));
	writeFileSync(
		join(scratch, ".pi", "onward.json"),
		JSON.stringify({
			rules: [{ stages: [{ minFailures: 1, action: { use: "onward.command", with: { name: "fixture" } } }] }],
		}),
	);
	trusted = false;
	await command.handler("reload", ctx);
	assert.match(notes.at(-1), /未受信任/);
	const untrusted = await emit("agent_before_settle", {
		outcome: "error",
		entries: [],
		continue: false,
		context: {
			contextEntries: [
				{
					sourceEntry: { id: "untrusted" },
					messages: [{ role: "assistant", stopReason: "error", errorMessage: "502", content: [] }],
				},
			],
		},
	});
	assert.equal(untrusted.continue, true);
	assert.equal(untrusted.entries[0].customType, "pi-onward");
	assert.deepEqual(deferred, []);
	await emit("session_shutdown", { reason: "reload" });

	// A separate extension implements the public discovery protocol without importing onward.
	const providerPath = join(scratch, "provider.ts");
	writeFileSync(
		providerPath,
		`export default function(pi) {
		let active = true;
		const unsubscribe = pi.events.on("onward:discover-actions", ({add}) => {
			if (!active) return;
			add({
				name: "fixture.recover", description: "External provider", phase: "settled", modes: ["tui"],
				parameters: {type: "object", required: ["value"], additionalProperties: false, properties: {value: {type: "string"}}},
				execute: (params, context) => {
					if (context.phase !== "settled" || !context.host.isIdle() || context.minFailures !== 1) throw new Error("wrong context");
					return {kind: "completed", message: params.value};
				}
			});
			add({
				name: "unused.broken", description: "Unused invalid provider", phase: "settled", modes: ["tui"],
				parameters: {type: "object", unknownKeyword: true}, execute: () => ({kind: "completed"})
			});
		});
		pi.on("session_shutdown", () => {active = false; unsubscribe();});
	}`,
	);
	writeFileSync(
		join(scratch, "onward.json"),
		JSON.stringify({
			rules: [
				{
					stages: [
						{ minFailures: 1, action: { use: "fixture.recover", with: { value: "external-provider-ok" } } },
					],
				},
			],
		}),
	);
	for (const order of [
		[entryPath, providerPath],
		[providerPath, entryPath],
	]) {
		const next = await loadExtensions(order, scratch, undefined, runtime);
		assert.deepEqual(next.errors, []);
		const onward = next.extensions.find((item) => item.commands.has("onward"));
		const notify = async (event, data = {}) => {
			for (const extension of next.extensions)
				for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
		};
		await notify("session_start", { reason: "startup" });
		assert.match(notes.at(-1), /动作注册/);
		await onward.commands.get("onward").handler("actions", ctx);
		assert.match(notes.at(-1), /unused\.broken[^\n]*unknownKeyword/);
		await notify("agent_before_settle", {
			outcome: "error",
			continue: false,
			entries: [],
			context: {
				contextEntries: [
					{
						sourceEntry: { id: "native-failure" },
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "502",
								provider: "test",
								model: "test",
								content: [],
							},
						],
					},
				],
			},
		});
		await notify("agent_settled", { aborted: false });
		assert.equal(deferred.length, 1);
		await onward.commands.get("onward").handler(deferred.shift().slice("/onward ".length), ctx);
		assert.match(notes.at(-1), /external-provider-ok/);
		await notify("session_shutdown", { reason: "reload" });
	}
	console.log(
		"Pi loader OK: stage selection, project trust, isolated registration failures, deferred command bridge and lifecycle cleanup",
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
