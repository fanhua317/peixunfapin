import { createQdrantClient, QDRANT_DEFAULT_COLLECTION } from "../src/qdrant.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--")) continue;
  const [key, ...rest] = arg.slice(2).split("=");
  args.set(key, rest.length ? rest.join("=") : "true");
}

const collectionName = args.get("collection") || process.env.QDRANT_COLLECTION || QDRANT_DEFAULT_COLLECTION;
const action = args.get("action") || process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "list";

async function main() {
  const qdrant = createQdrantClient();
  await qdrant.ping();
  if (action === "create") {
    const result = await qdrant.createSnapshot(collectionName);
    console.log(JSON.stringify({ ok: true, action, collection: collectionName, result: result?.result || result }, null, 2));
    return;
  }
  if (action === "list") {
    const result = await qdrant.listSnapshots(collectionName);
    console.log(JSON.stringify({ ok: true, action, collection: collectionName, snapshots: result?.result || [] }, null, 2));
    return;
  }
  throw new Error(`Unknown action: ${action}. Use list or create.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
