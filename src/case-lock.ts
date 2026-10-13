import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const localCaseLock = fileURLToPath(new URL("../runs/.case-run.lock/", import.meta.url));

export async function processStamp(pid: number): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
}

export async function withCaseLock<T>(lockDirectory: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockDirectory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Another case run holds the lock. If it crashed, confirm it has stopped before removing .case-run.lock.");
    }
    throw error;
  }
  try {
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), stamp: await processStamp(process.pid).catch(() => null),
    }), { mode: 0o600 });
    return await run();
  } finally {
    await rm(lockDirectory, { recursive: true });
  }
}
