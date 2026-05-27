import path from "node:path";
import { cleanRawDirectory } from "../src/import/cleaner.mjs";

const rawDir = path.resolve(process.argv[2] || process.env.TRAINING_RAW_DIR || "D:\\OpenClawData\\training-raw");
const cleanDir = path.resolve(process.argv[3] || process.env.TRAINING_CLEAN_DIR || "D:\\OpenClawData\\training-clean");

const result = await cleanRawDirectory({ rawDir, cleanDir });
for (const item of result.outputs) {
  console.log(`CLEAN ${item.input} -> ${item.output}`);
}
for (const item of result.failures) {
  console.error(`FAIL ${item.input}: ${item.error}`);
}
console.log(JSON.stringify(result, null, 2));
if (result.failed) process.exitCode = 1;
