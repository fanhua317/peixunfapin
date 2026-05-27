import { dataDir, defaultState, statePath } from "../src/store.mjs";
import { defaultMemoryStore, memoryPath } from "../src/memory/store.mjs";
import { closeTrainingDatabase, migrateJsonToSqlite } from "../src/sqlite-store.mjs";

const args = new Set(process.argv.slice(2));
const summary = migrateJsonToSqlite({
  dataDir,
  statePath,
  memoryPath,
  defaultState,
  defaultMemoryStore,
  dryRun: args.has("--dry") || args.has("--dry-run"),
  force: args.has("--force"),
});

console.log(JSON.stringify(summary, null, 2));
closeTrainingDatabase();
