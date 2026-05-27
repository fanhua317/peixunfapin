import { restoreDataBackup } from "../src/data-backup.mjs";

function parseArgs(argv) {
  const args = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--from") {
      args.from = argv[index + 1];
      index += 1;
      continue;
    }
    if (item === "--force") args.force = true;
  }
  return args;
}

const summary = await restoreDataBackup(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(summary, null, 2));
