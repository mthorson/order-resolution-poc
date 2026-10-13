import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { withCaseLock } from "../src/case-lock.ts";

const exec = promisify(execFile);

async function temporaryLock(run: (lock: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "case-lock-"));
  try { await run(join(folder, ".case-run.lock")); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test("releases the lock after success and failure", async () => {
  await temporaryLock(async (lock) => {
    assert.equal(await withCaseLock(lock, async () => "done"), "done");
    await assert.rejects(access(lock));
    await assert.rejects(withCaseLock(lock, async () => { throw new Error("failed"); }), /failed/);
    await assert.rejects(access(lock));
    await withCaseLock(lock, async () => {
      const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.deepEqual(Object.keys(owner).sort(), ["pid", "stamp", "startedAt"]);
    });
  });
});

test("rejects overlapping runs without removing the active owner's lock", async () => {
  await temporaryLock(async (lock) => {
    await withCaseLock(lock, async () => {
      await assert.rejects(withCaseLock(lock, async () => {}), /Another case run/);
      await access(lock);
    });
  });
});

test("a second process cannot acquire the same lock", async () => {
  await temporaryLock(async (lock) => {
    const moduleUrl = new URL("../src/case-lock.ts", import.meta.url).href;
    const script = `import { withCaseLock } from ${JSON.stringify(moduleUrl)}; await withCaseLock(${JSON.stringify(lock)}, async () => {});`;
    await withCaseLock(lock, async () => {
      await assert.rejects(exec(process.execPath, ["--input-type=module", "--eval", script]), (error: unknown) => {
        assert.ok(error instanceof Error && "stderr" in error);
        assert.match(String(error.stderr), /Another case run/);
        return true;
      });
      await access(lock);
    });
  });
});
