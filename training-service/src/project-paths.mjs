import path from "node:path";

export const trainingServiceRoot = path.resolve(import.meta.dirname, "..");
export const repoRoot = path.resolve(trainingServiceRoot, "..");
export const projectRoot = path.resolve(repoRoot, "..");

export const dataRoot = process.env.TRAINING_DATA_ROOT
  ? path.resolve(process.env.TRAINING_DATA_ROOT)
  : path.join(projectRoot, "data");

export function dataRootPath(...parts) {
  return path.join(dataRoot, ...parts);
}
