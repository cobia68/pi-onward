import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { builtinActions } from "../src/actions/builtins.ts";
import { ActionRegistry } from "../src/actions/registry.ts";
import { matchFailure, mergeLayers, parseLayer } from "../src/policy/config.ts";
import { SCHEMA_URL } from "../src/policy/schema.ts";
import { err, harness } from "./support/fake-pi.ts";

const json = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
test("分发示例可直接解析，所有动作存在且按阶段执行", () => {
	const h = harness();
	const registry = new ActionRegistry();
	registry.discover(h.pi, builtinActions(h.pi));
	const raw = json("example.json");
	assert.equal(raw.$schema, SCHEMA_URL);
	const config = mergeLayers([parseLayer(raw)]);
	assert.deepEqual(config.problems, []);
	assert.deepEqual(registry.problems(config), []);
	assert.equal(matchFailure(config, err("502 Bad Gateway"), 3)?.stage.action.use, "onward.resend");
	assert.equal(matchFailure(config, err("502 Bad Gateway"), 4)?.stage.action.use, "onward.stop");
});
test("README 完整 JSON 配置均可解析，公共动作入口和文档随包分发", () => {
	for (const block of readme.matchAll(/```json\n([\s\S]*?)\n```/g)) {
		const raw = JSON.parse(block[1]!);
		if (raw.rules) assert.deepEqual(parseLayer(raw).problems, []);
	}
	const manifest = json("package.json");
	assert.equal(manifest.exports["./actions"], "./src/actions/protocol.ts");
	assert.ok(manifest.files.includes("docs/"));
	assert.ok(readme.includes(SCHEMA_URL));
});
