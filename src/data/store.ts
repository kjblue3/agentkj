import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { demoEvidence } from "./demoData.js";
import { evidenceItemSchema, type EvidenceItem } from "../types/schemas.js";

const evidenceListSchema = z.array(evidenceItemSchema);

export async function loadEvidence(path = process.env.DATA_PATH): Promise<EvidenceItem[]> {
  if (!path) return demoEvidence;
  try {
    const raw = await readFile(resolve(path), "utf8");
    return evidenceListSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.warn(`Could not load DATA_PATH=${path}; using bundled demo data.`, error);
    return demoEvidence;
  }
}

export function normalizeEvidence(input: unknown): EvidenceItem {
  return evidenceItemSchema.parse(input);
}
