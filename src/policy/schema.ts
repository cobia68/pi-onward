/**
 * 设置文件 `onward.json` 的 JSON Schema，给编辑器补全和检查用。参数来自 policy.ts 的同一张字段表，和读设置时
 * 收下的写法一致。生成的文件是仓库根目录的 onward.schema.json：`npm run gen:schema` 重新生成，测试检查它没有过期。
 *
 * Schema 只管写法，而且不拒绝读设置时收下的：正则对不对、重名的规则、封顶小于起步这类问题，仍由 config.ts
 * 记成问题。`error` 不写 `format: "regex"`：校验器按 `u` 模式检查，会拒绝读设置时收下的写法，如 `[\w-.]`。
 */
import { delayText } from "./delay.ts";
import { DEFAULT_POLICY, FIELDS, type Field } from "./policy.ts";

/** 发布的位置：同步到 GitHub 的仓库根目录。设置文件的 `$schema` 写它。 */
export const SCHEMA_URL = "https://raw.githubusercontent.com/cobia68/pi-onward/main/onward.schema.json";

/** 一个参数：作用和取值说明。顶层的带内置默认值 `fallback`；规则里的不带，说它覆盖顶层的。 */
function param(item: Field, fallback?: unknown): Record<string, unknown> {
	const choices = item.choices?.map((choice) => `${choice.value}：${choice.description}`).join("；");
	// 写法是「文字」时不重复：类型已经是 string。
	const syntax = item.syntax === "文字" ? "" : `（${item.syntax}）`;
	const what = choices ? `${item.description}。${choices}` : `${item.description}${syntax}`;
	return {
		description: fallback === undefined ? `${what}。覆盖顶层的同名字段` : what,
		...item.schema,
		...(fallback !== undefined && { default: fallback }),
	};
}

/** 内置默认值写成设置文件里的样子：间隔是 `3s..15s` 这样的文字。 */
function fileValue(name: string): unknown {
	const value = DEFAULT_POLICY[name as keyof typeof DEFAULT_POLICY];
	return name === "delay" ? delayText(DEFAULT_POLICY.delay) : value;
}

export function configSchema(): Record<string, unknown> {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: SCHEMA_URL,
		title: "pi-onward 设置",
		description:
			"~/.pi/agent/onward.json（全局）或 .pi/onward.json（项目级）。顶层的参数是每条规则的默认值，规则里同名的字段覆盖它",
		type: "object",
		additionalProperties: false,
		properties: {
			$schema: { description: "这份 JSON Schema 的地址，给编辑器用", type: "string" },
			enabled: { description: "插件开关", type: "boolean", default: true },
			...Object.fromEntries(FIELDS.map((item) => [item.name, param(item, fileValue(item.name))])),
			rules: {
				description: "按顺序第一条命中的生效；没命中的错误和空回复不处理",
				type: "array",
				items: { $ref: "#/$defs/rule" },
			},
		},
		$defs: {
			rule: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: {
						description: "规则名，出现在通知里，不能重名；不写时按位置叫 rule-1、rule-2",
						type: "string",
						pattern: "\\S",
					},
					enabled: { description: "false 时保留但跳过", type: "boolean", default: true },
					when: { $ref: "#/$defs/when" },
					...Object.fromEntries(FIELDS.map((item) => [item.name, param(item)])),
				},
			},
			when: {
				description: "命中条件，几项都要满足；不写 when 的规则管所有错误，不管空回复",
				type: "object",
				additionalProperties: false,
				properties: {
					empty: { description: "只管空回复，不管出错；不能和 error 一起写", const: true },
					error: {
						description: "正则，大小写不敏感，对原始错误文案匹配",
						type: "string",
						minLength: 1,
					},
					provider: {
						description: "通配，只有 * 有特殊含义，大小写不敏感，整串匹配",
						type: "string",
						pattern: "\\S",
					},
					model: {
						description: "通配，只有 * 有特殊含义，大小写不敏感，整串匹配",
						type: "string",
						pattern: "\\S",
					},
				},
				// 写了 empty 就不能写 error：编辑器把问题标在 error 上。
				dependentSchemas: { empty: { properties: { error: false } } },
			},
		},
	};
}
