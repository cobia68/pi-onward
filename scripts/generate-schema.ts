// 按字段表生成仓库根目录的 onward.schema.json：改了字段、取值或默认值之后运行 npm run gen:schema。
import { writeFileSync } from "node:fs";
import { configSchema } from "../src/policy/schema.ts";

const target = new URL("../onward.schema.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(configSchema(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
