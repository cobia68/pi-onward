/** Discovers executable actions; configuration is linked only after all extension factories have registered. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { Config } from "../policy/config.ts";
import { errorText, isRecord } from "../util.ts";
import {
	ACTION_NAME_PATTERN,
	type ActionCall,
	type ActionDefinition,
	DISCOVER_ACTIONS,
	type ExtensionMode,
	type Parameters,
} from "./protocol.ts";

export interface RegisteredAction {
	definition: ActionDefinition;
	validate: ValidateFunction;
}
export class ActionRegistry {
	private actions = new Map<string, RegisteredAction>();
	private errors: string[] = [];

	discover(pi: Pick<ExtensionAPI, "events">, builtins: readonly ActionDefinition[]): void {
		this.actions.clear();
		this.errors = [];
		const seen = new Set<string>();
		const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
		const add = (candidate: unknown) => {
			try {
				if (!isDefinition(candidate))
					throw new Error("Invalid action definition: expected name, parameter schema, phase, modes, and execute");
				if (seen.has(candidate.name)) {
					this.actions.delete(candidate.name);
					throw new Error("Duplicate action name");
				}
				seen.add(candidate.name);
				const definition = {
					...candidate,
					modes: [...candidate.modes],
					parameters: structuredClone(candidate.parameters),
				};
				const validate = ajv.compile(definition.parameters);
				if ((validate as ValidateFunction & { $async?: boolean }).$async)
					throw new Error("Parameter schema must validate synchronously");
				this.actions.set(definition.name, { definition, validate });
			} catch (error) {
				const name = isRecord(candidate) && typeof candidate.name === "string" ? candidate.name : "<unnamed>";
				this.errors.push(`Action ${name} registration failed: ${errorText(error)}`);
			}
		};
		for (const definition of builtins) add(definition);
		// Synchronous declarations only. Ignore late callbacks, including asynchronous event handlers.
		let accepting = true;
		pi.events.emit(DISCOVER_ACTIONS, {
			add: (definition: unknown) => {
				if (accepting) add(definition);
			},
		});
		accepting = false;
	}
	clear(): void {
		this.actions.clear();
		this.errors = [];
	}
	list(): ActionDefinition[] {
		return [...this.actions.values()].map((entry) => entry.definition);
	}
	get(name: string): RegisteredAction | undefined {
		return this.actions.get(name);
	}
	/** 注册表诊断独立于配置有效性；未引用的坏动作不能阻断其他动作。 */
	get diagnostics(): readonly string[] {
		return this.errors;
	}
	problems(config: Config): string[] {
		const errors: string[] = [];
		for (const rule of config.rules) {
			if (!rule.enabled) continue;
			for (const stage of rule.stages) {
				const problem = this.check(stage.action);
				if (problem) errors.push(`Rule "${rule.name}", minFailures ${stage.minFailures}: ${problem}`);
			}
		}
		return errors;
	}
	check(call: ActionCall): string | undefined {
		const registered = this.get(call.use);
		if (!registered) return `Action ${call.use} is not loaded or failed to register`;
		if (!registered.validate(call.with ?? {}))
			return `Invalid parameters for ${call.use}: ${registered.validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`;
		return undefined;
	}
	parameters(call: ActionCall): Parameters {
		return structuredClone(call.with ?? {});
	}
}
function isDefinition(value: unknown): value is ActionDefinition {
	if (!isRecord(value)) return false;
	const modes: ExtensionMode[] = ["tui", "rpc", "json", "print"];
	return (
		typeof value.name === "string" &&
		new RegExp(ACTION_NAME_PATTERN).test(value.name) &&
		typeof value.description === "string" &&
		isRecord(value.parameters) &&
		(value.phase === "boundary" || value.phase === "settled") &&
		Array.isArray(value.modes) &&
		value.modes.length > 0 &&
		value.modes.every((mode) => modes.includes(mode)) &&
		(value.handoff === undefined || (value.phase === "settled" && typeof value.handoff === "boolean")) &&
		typeof value.execute === "function"
	);
}
