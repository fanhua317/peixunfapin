import { buildLocalVectorIndex, localVectorBuildDefaults } from "../src/local-vector-build.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--")) continue;
  const [key, ...rest] = arg.slice(2).split("=");
  args.set(key, rest.length ? rest.join("=") : "true");
}

const options = localVectorBuildDefaults({
  kbId: args.get("kb") || process.env.EMBED_KB_ID || "",
  model: args.get("model"),
  outputPath: args.get("out"),
  full: args.has("full"),
  forceAll: args.has("full") || /^1|true|yes$/i.test(process.env.EMBED_FORCE_FULL || ""),
  dryRun: args.has("dry"),
});

buildLocalVectorIndex({
  ...options,
  onProgress: (progress) => {
    if (progress.stage === "embedding") process.stdout.write(`${progress.detail}\n`);
  },
}).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
