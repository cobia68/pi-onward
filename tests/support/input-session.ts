/** Real Pi input dispatch and session persistence, with an in-process model and isolated files. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { install } from "../../src/extension/install.ts";
import { assistant } from "./fake-pi.ts";

export async function inputSession(
	options: {
		extension?: ExtensionFactory;
		providerFirst?: boolean;
		maxFailures?: number;
		beforeReply?: (session: AgentSession, request: number) => Promise<void>;
		fails?: (request: number) => boolean;
	} = {},
) {
	const scratch = mkdtempSync(join(tmpdir(), "onward-input-test-"));
	const agentDir = join(scratch, "agent");
	mkdirSync(agentDir);
	const configPath = join(agentDir, "onward.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			quietStartup: true,
			maxFailures: options.maxFailures ?? 2,
			rules: [
				{ stages: [{ minFailures: 1, action: { use: "pi.message", with: { prompt: "Retry: {taskPrompt}" } } }] },
			],
		}),
	);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-cache.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider("onward-input-test", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "local-fixture",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64000,
				maxTokens: 512,
			},
		],
	});
	const onward: ExtensionFactory = (pi) =>
		install(pi, {
			global: configPath,
			project: (cwd) => join(cwd, ".pi", "onward.json"),
		});
	const factories = options.extension
		? options.providerFirst
			? [options.extension, onward]
			: [onward, options.extension]
		: [onward];
	const loader = new DefaultResourceLoader({
		cwd: scratch,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: factories,
	});
	await loader.reload();
	const manager = SessionManager.inMemory(scratch);
	const { session, extensionsResult } = await createAgentSession({
		cwd: scratch,
		agentDir,
		resourceLoader: loader,
		modelRuntime,
		model: modelRuntime.getModel("onward-input-test", "fixture"),
		sessionManager: manager,
		settingsManager,
		noTools: "all",
	});
	assert.deepEqual(extensionsResult.errors, []);
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
	let requests = 0;
	const inputs: string[][] = [];
	session.agent.streamFunction = (_model, context) => {
		const stream = createAssistantMessageEventStream();
		const current = ++requests;
		inputs.push(context.messages.filter((m) => m.role === "user").map((m) => text(m.content)));
		void (async () => {
			await options.beforeReply?.(session, current);
			const failed = options.fails?.(current) ?? current === 1;
			const message = assistant({
				api: "openai-completions",
				provider: "onward-input-test",
				model: "fixture",
				content: failed ? [] : [{ type: "text", text: "done" }],
				stopReason: failed ? "error" : "stop",
				timestamp: Date.now(),
				...(failed && { errorMessage: "NON_RETRYABLE_FIXTURE_FAILURE" }),
			});
			stream.push(
				failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message },
			);
			stream.end();
		})().catch((error) => {
			errors.push(error);
			stream.push({
				type: "error",
				reason: "error",
				error: assistant({ stopReason: "error", errorMessage: String(error) }),
			});
			stream.end();
		});
		return stream;
	};
	return {
		session,
		manager,
		inputs,
		get requests() {
			return requests;
		},
		continuations: () =>
			manager
				.getEntries()
				.flatMap((e) => (e.type === "custom_message" && e.customType === "pi-onward" ? [text(e.content)] : [])),
		cleanup() {
			session.dispose();
			rmSync(scratch, { recursive: true, force: true });
			assert.deepEqual(errors, []);
		},
	};
}
function text(content: string | { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n");
}
