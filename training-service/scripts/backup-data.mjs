import { createDataBackup } from "../src/data-backup.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--out") {
      args.out = argv[index + 1];
      index += 1;
      continue;
    }
    if (item === "--retention-days") {
      args.retentionDays = argv[index + 1];
      index += 1;
      continue;
    }
    if (item === "--keep-last") {
      args.keepLast = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

const summary = await createDataBackup(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(summary, null, 2));
