/** Structural JSON Schema. Loaded action providers validate their own parameters at runtime. */
import { ACTION_NAME_PATTERN } from "../actions/protocol.ts";
import { DELAY_PATTERN } from "./delay.ts";
import { DEFAULT_LIMITS, FIELDS } from "./policy.ts";
export const SCHEMA_URL = "https://raw.githubusercontent.com/cobia68/pi-onward/main/onward.schema.json";
export function configSchema(): Record<string, unknown> {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: SCHEMA_URL,
		title: "pi-onward 阶段恢复策略",
		type: "object",
		additionalProperties: false,
		properties: {
			$schema: { type: "string" },
			enabled: { type: "boolean", default: true },
			quietStartup: { type: "boolean", description: "仅允许写在全局；未配置时跟随 Pi" },
			...Object.fromEntries(
				FIELDS.map((field) => [
					field.name,
					{
						...field.schema,
						description: field.description,
						default: field.name === "actionTimeout" ? "30s" : DEFAULT_LIMITS[field.name],
					},
				]),
			),
			rules: { type: "array", items: { $ref: "#/$defs/rule" } },
		},
		$defs: {
			rule: {
				type: "object",
				additionalProperties: false,
				required: ["stages"],
				properties: {
					name: { type: "string", pattern: "\\S" },
					enabled: { type: "boolean", default: true },
					when: { $ref: "#/$defs/when" },
					stages: {
						type: "array",
						minItems: 1,
						description: "minFailures 严格递增；每次失败选择达到下限的最后一个阶段",
						prefixItems: [
							{
								allOf: [
									{ $ref: "#/$defs/stage" },
									{ type: "object", properties: { minFailures: { const: 1 } } },
								],
							},
						],
						items: { $ref: "#/$defs/stage" },
					},
				},
			},
			when: {
				type: "object",
				additionalProperties: false,
				properties: {
					failure: { type: "string", minLength: 1, description: "大小写不敏感的正则；空回复用 ^$，所有失败用 .*" },
					provider: { type: "string", pattern: "\\S" },
					model: { type: "string", pattern: "\\S" },
				},
			},
			stage: {
				type: "object",
				additionalProperties: false,
				required: ["minFailures", "action"],
				properties: {
					minFailures: {
						type: "integer",
						minimum: 1,
						maximum: 1000,
						description: "阶段生效的连续失败次数下限，包含当前失败",
					},
					delay: {
						type: "string",
						pattern: DELAY_PATTERN,
						default: "0s",
						description: "在当前阶段内按失败次数推进；省略时不等待",
					},
					action: { $ref: "#/$defs/action" },
				},
			},
			action: {
				type: "object",
				additionalProperties: false,
				required: ["use"],
				properties: {
					use: { type: "string", pattern: ACTION_NAME_PATTERN },
					with: { type: "object", description: "由已加载动作提供的 JSON Schema 校验；不执行隐式类型转换" },
				},
			},
		},
	};
}
