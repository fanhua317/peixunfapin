import { verifyDataBackup } from "../src/data-backup.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--from") {
      args.from = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

const summary = await verifyDataBackup(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(summary, null, 2));
