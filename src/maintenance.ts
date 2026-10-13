import { mkdir, readdir, readFile, realpath, lstat, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { sha256 } from "./bundle-integrity.ts";
import { z } from "zod";

const manifestSchema = z.strictObject({ version: z.literal("backup.v1"), createdAt: z.iso.datetime(),
  files: z.array(z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
async function inactive(root: string) {
  for (const lock of [join(root, "runs/.worker-lock"), join(root, "runs/.case-run.lock")]) {
    try { await lstat(lock); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    throw new Error("Stop the app and worker before maintenance");
  }
}
async function files(directory: string, prefix = ""): Promise<string[]> {
  const names = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const name of names) {
    const path = join(prefix, name.name);
    if (name.isSymbolicLink()) throw new Error("Backups reject symbolic links");
    if (name.isDirectory()) result.push(...await files(join(directory, name.name), path));
    else if (name.isFile()) result.push(path);
  }
  return result;
}
const safePath = (path: string) => /^(runs|fixtures\/patients|evals\/(heldout|final)\/patients)\//.test(path) &&
  !path.split(/[\\/]/).some((part) => ["..", ".", ""].includes(part)) && !path.includes("\\");

export async function backup(root: string, destination: string) {
  await inactive(root);
  const target = resolve(destination);
  if (target === resolve(root) || target.startsWith(resolve(root) + sep)) throw new Error("Keep backups outside the working project");
  await mkdir(target, { mode: 0o700 });
  const entries: { path: string; sha256: string }[] = [];
  for (const prefix of ["runs", "fixtures/patients", "evals/heldout/patients", "evals/final/patients"]) {
    const directory = join(root, prefix);
    let paths: string[];
    try { paths = await files(directory); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    for (const suffix of paths) {
      const path = `${prefix}/${suffix}`;
      if (!safePath(path)) throw new Error("Unexpected backup path");
      const body = await readFile(join(root, path));
      await mkdir(dirname(join(target, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(target, path), body, { mode: 0o600, flag: "wx" });
      entries.push({ path, sha256: sha256(body) });
    }
  }
  await writeFile(join(target, "manifest.json"), JSON.stringify({ version: "backup.v1", createdAt: new Date().toISOString(), files: entries }, null, 2), { mode: 0o600, flag: "wx" });
  return { files: entries.length };
}

export async function restore(source: string, root: string) {
  const sourceRoot = await realpath(source);
  const target = await realpath(root);
  await inactive(target);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(sourceRoot, "manifest.json"), "utf8")));
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) throw new Error("Duplicate backup file");
  // Verify the entire backup before changing the target.
  for (const file of manifest.files) {
    if (!safePath(file.path)) throw new Error("Unsafe restore path");
    const path = await realpath(join(sourceRoot, file.path));
    if (!path.startsWith(sourceRoot + sep) || sha256(await readFile(path)) !== file.sha256) throw new Error("Backup integrity failed");
    let current = target;
    for (const part of file.path.split("/")) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Restore target contains a symbolic link"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    try {
      const existing = await readFile(join(target, file.path));
      if (sha256(existing) !== file.sha256) throw new Error("Existing target file differs; restore into clean storage");
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  for (const file of manifest.files) {
    const path = join(target, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await writeFile(path, await readFile(join(sourceRoot, file.path)), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  return { files: manifest.files.length };
}

export async function cleanup(root: string, days: number, apply = false) {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error("Retention must be at least one day");
  await inactive(root);
  const runs = join(root, "runs");
  const referenced = new Set<string>();
  for (const path of await files(runs)) {
    if (!path.endsWith(".json") || /^[a-f0-9-]{36}\//.test(path)) continue;
    const text = await readFile(join(runs, path), "utf8");
    for (const match of text.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g)) referenced.add(match[0]);
  }
  const removed: string[] = [];
  for (const name of await readdir(runs)) {
    if (!/^[a-f0-9-]{36}$/.test(name) || referenced.has(name)) continue;
    const path = join(runs, name);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.mtimeMs > Date.now() - days * 86_400_000) continue;
    try { if ((await readdir(join(path, "reviews"))).length) continue; } catch { /* No reviews. */ }
    if (apply) await rm(path, { recursive: true });
    removed.push(name);
  }
  return { apply, eligibleRunIds: removed };
}
