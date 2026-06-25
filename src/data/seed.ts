import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoEvidence } from "./demoData.js";

export async function seed(outputPath?: string): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(moduleDir, "../../data/evidence.json");
  const target = resolve(outputPath ?? process.env.DATA_PATH ?? defaultPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(demoEvidence, null, 2)}\n`, "utf8");
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed()
    .then((path) => console.log(`Seeded ${demoEvidence.length} evidence items to ${path}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
