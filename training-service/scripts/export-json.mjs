import { dataDir, statePath } from "../src/store.mjs";
import { memoryPath } from "../src/memory/store.mjs";
import { closeTrainingDatabase, exportSqliteToJson } from "../src/sqlite-store.mjs";

const summary = exportSqliteToJson({
  dataDir,
  statePath,
  memoryPath,
});

console.log(JSON.stringify(summary, null, 2));
closeTrainingDatabase();
