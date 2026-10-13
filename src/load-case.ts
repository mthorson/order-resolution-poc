import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CaseBundle, CaseSource } from "./contracts.ts";
import { sha256, snapshotId } from "./bundle-integrity.ts";

export type LoadLimits = { maxSources: number; maxInputBytes: number };
export const defaultLoadLimits: LoadLimits = {
  maxSources: 32,
  maxInputBytes: 256 * 1024,
};

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("Expected a regular file");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error("Case exceeds input byte limit");
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseManifest(value: unknown, maxSources: number) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Manifest must be an object");
  }
  if (!("synthetic" in value) || value.synthetic !== true ||
      !("patient_id" in value) || !nonempty(value.patient_id) ||
      !("case_id" in value) || !nonempty(value.case_id) ||
      !("files" in value) || !Array.isArray(value.files) ||
      value.files.length === 0 || value.files.length > maxSources) {
    throw new Error("Invalid manifest identity or file list");
  }
  const files: string[] = [];
  for (const entry of value.files) {
    if (!nonempty(entry) || !/^(documents|correspondence)\/[A-Za-z0-9_-]+\.txt$/.test(entry)) {
      throw new Error("Source paths must name text files inside the case folders");
    }
    files.push(entry);
  }
  if (new Set(files).size !== files.length) throw new Error("Duplicate source path");
  return { patientId: value.patient_id, caseId: value.case_id, files: files.sort() };
}

async function resolveInside(root: string, path: string): Promise<string> {
  const resolved = await realpath(resolve(root, path));
  const suffix = relative(root, resolved);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new Error("Source resolves outside the case folder");
  }
  return resolved;
}

export async function loadCase(
  folder: string,
  limits: LoadLimits = defaultLoadLimits,
): Promise<CaseBundle> {
  for (const limit of Object.values(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Limits must be positive integers");
  }
  const root = await realpath(folder);
  const manifestBytes = await readBounded(
    await resolveInside(root, "manifest.json"),
    Math.min(64 * 1024, limits.maxInputBytes),
  );
  const manifest = parseManifest(JSON.parse(decode(manifestBytes)), limits.maxSources);
  let remaining = limits.maxInputBytes - manifestBytes.length;
  const sources: CaseSource[] = [];
  for (const path of manifest.files) {
    const bytes = await readBounded(await resolveInside(root, path), remaining);
    remaining -= bytes.length;
    const content = decode(bytes);
    if (!content.trim()) throw new Error(`Empty source: ${path}`);
    sources.push({
      sourceId: path,
      path,
      kind: path.startsWith("documents/") ? "document" : "correspondence",
      content,
      sha256: sha256(bytes),
    });
  }
  return {
    schemaVersion: "case-bundle.v1",
    patientId: manifest.patientId,
    caseId: manifest.caseId,
    snapshotId: snapshotId(manifest.patientId, manifest.caseId, sources),
    sources,
  };
}
