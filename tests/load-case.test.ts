import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCase } from "../src/load-case.ts";

async function temporaryCase(run: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "order-case-"));
  try {
    await mkdir(join(folder, "documents"));
    await writeFile(join(folder, "documents/source.txt"), "Patient ID: SYN-001\n");
    await writeFile(join(folder, "manifest.json"), JSON.stringify({
      synthetic: true, patient_id: "SYN-001", case_id: "CASE-001",
      files: ["documents/source.txt"],
    }));
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("all five fixtures load without expected answers", async () => {
  for (let id = 1; id <= 5; id++) {
    const bundle = await loadCase(`fixtures/patients/patient-00${id}`);
    assert.equal(bundle.caseId, `CASE-00${id}`);
    assert.equal(bundle.sources.length, id === 3 || id === 5 ? 4 : 3);
    assert.match(bundle.snapshotId, /^[a-f0-9]{64}$/);
  }
});

test("same files give the same snapshot; changed content changes it", async () => {
  await temporaryCase(async (folder) => {
    const first = await loadCase(folder);
    assert.equal((await loadCase(folder)).snapshotId, first.snapshotId);
    await writeFile(join(folder, "documents/source.txt"), "Patient ID: SYN-002\n");
    assert.notEqual((await loadCase(folder)).snapshotId, first.snapshotId);
  });
});

test("manifest file order does not change the snapshot", async () => {
  await temporaryCase(async (folder) => {
    await writeFile(join(folder, "documents/second.txt"), "Second source\n");
    const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
    manifest.files.push("documents/second.txt");
    await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
    const first = await loadCase(folder);
    manifest.files.reverse();
    await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
    assert.equal((await loadCase(folder)).snapshotId, first.snapshotId);
  });
});

test("rejects malformed manifests, traversal, and duplicate files", async () => {
  await temporaryCase(async (folder) => {
    for (const manifest of [null, {}, {
      synthetic: true, patient_id: "SYN-001", case_id: "CASE-001", files: ["../outside.txt"],
    }, {
      synthetic: true, patient_id: "SYN-001", case_id: "CASE-001",
      files: ["documents/source.txt", "documents/source.txt"],
    }]) {
      await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
      await assert.rejects(loadCase(folder));
    }
  });
});

test("rejects an external symlink", async () => {
  await temporaryCase(async (folder) => {
    await rm(join(folder, "documents/source.txt"));
    await symlink(join(process.cwd(), "AGENTS.md"), join(folder, "documents/source.txt"));
    await assert.rejects(loadCase(folder), /outside the case folder/);
  });
});

test("rejects oversized, missing, empty, and invalid UTF-8 sources", async () => {
  await temporaryCase(async (folder) => {
    const source = join(folder, "documents/source.txt");
    await writeFile(source, "x".repeat(1000));
    await assert.rejects(loadCase(folder, { maxSources: 2, maxInputBytes: 500 }), /byte limit/);
    await writeFile(source, "   ");
    await assert.rejects(loadCase(folder), /Empty source/);
    await writeFile(source, Buffer.from([0xff]));
    await assert.rejects(loadCase(folder));
    await rm(source);
    await assert.rejects(loadCase(folder));
  });
});
