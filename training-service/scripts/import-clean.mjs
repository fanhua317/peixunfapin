import path from "node:path";
import { importCleanDirectory } from "../src/import/importer.mjs";

const inputDir = path.resolve(process.argv[2] || process.env.TRAINING_CLEAN_DIR || "D:\\OpenClawData\\training-clean");
const kbName = process.argv[3] || process.env.TRAINING_KB_NAME || path.basename(inputDir) || "自定义培训资料库";
const aliases = process.argv[4] || process.env.TRAINING_KB_ALIASES || "";

const imported = await importCleanDirectory({ inputDir, kbName, aliases });
console.log(JSON.stringify(imported, null, 2));
