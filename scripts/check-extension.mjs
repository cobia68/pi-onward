// 用 pi 自己的加载器加载 package.json 里声明的入口：不开会话、不调模型，只确认能加载、命令和事件都注册上。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// 指到一个不存在的设置文件，免得读到本机的 onward.json。
process.env.PI_ONWARD_CONFIG = join(tmpdir(), `pi-onward-check-${process.pid}.json`);
process.env.PI_AUTO_CONTINUE_CONFIG = join(tmpdir(), `pi-onward-check-legacy-${process.pid}.json`);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const entries = manifest.pi.extensions.map((entry) => resolve(root, entry));
const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(pathToFileURL(resolve(sdk, "core/extensions/loader.js")).href);
const result = await loadExtensions(entries, root);
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, 1);
const [extension] = result.extensions;
const command = extension.commands.get("onward");
assert.ok(command, "the onward command is registered");
let text = "";
await command.handler("", { hasUI: true, ui: { notify: (message) => (text = message) } });
assert.match(text, /^onward：开，没有可用的规则.*发「继续」，最多 10 次/);
for (const event of [
	"agent_start",
	"message_end",
	"agent_before_settle",
	"agent_settled",
	"session_start",
	"session_shutdown",
])
	assert.ok(extension.handlers.has(event), `${event} handler`);
console.log("pi extension loaded: /onward, default status, lifecycle handlers");
