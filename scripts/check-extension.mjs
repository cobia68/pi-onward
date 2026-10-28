// 用 pi 自己的加载器加载 package.json 里声明的入口：不开会话、不调模型，只确认能加载、命令和事件都注册上，
// 以及设置文件的位置跟 pi 走。两次都指到不存在的文件，免得读到本机的 onward.json；只读不写。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const entries = manifest.pi.extensions.map((entry) => resolve(root, entry));
const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(pathToFileURL(resolve(sdk, "core/extensions/loader.js")).href);

/** 加载一次入口，返回注册上的扩展和 `/onward` 的回复。 */
async function load() {
	const result = await loadExtensions(entries, root);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	const [extension] = result.extensions;
	const command = extension.commands.get("onward");
	assert.ok(command, "the onward command is registered");
	let text = "";
	await command.handler("status", { hasUI: true, ui: { notify: (message) => (text = message) } });
	return { extension, text };
}

// 设置文件在 pi 的目录里：`PI_CODING_AGENT_DIR` 和 pi 一样展开 `~`。
const agentDir = `.pi-onward-check-${process.pid}`;
delete process.env.PI_ONWARD_CONFIG;
process.env.PI_CODING_AGENT_DIR = `~/${agentDir}`;
const { extension, text } = await load();
assert.match(text, /^💤 onward：开，但没有可用的规则[\s\S]*做法 {2}发「继续」\n {2}上限 {2}最多 10 次/);
assert.ok(text.includes(`  ${join(homedir(), agentDir, "onward.json")}（还没有`), text);
assert.ok(extension.messageRenderers.has("pi-onward"), "continue message renderer");
for (const event of [
	"agent_start",
	"message_end",
	"agent_before_settle",
	"agent_settled",
	"session_start",
	"session_shutdown",
])
	assert.ok(extension.handlers.has(event), `${event} handler`);

// `PI_ONWARD_CONFIG` 优先。
const override = join(tmpdir(), `pi-onward-check-${process.pid}.json`);
process.env.PI_ONWARD_CONFIG = override;
assert.ok((await load()).text.includes(`  ${override}（还没有`), "PI_ONWARD_CONFIG");

console.log("pi extension loaded: /onward status, lifecycle handlers, message renderer, settings path");
