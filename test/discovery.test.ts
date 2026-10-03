// test/discovery.test.ts — binary discovery against scripted binaries: the
// newest copy wins regardless of PATH order; the pin is reused while the
// candidate set is unchanged and re-probed on install, upgrade or removal;
// aliases of one file are one candidate.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "subturn-discovery-"));
process.env["SUBTURN_STATE_DIR"] = path.join(root, "state");

const { resolvePin } = await import("../src/core/discovery.ts");

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

let tick = 1_000_000_000; // distinct mtimes without sleeping
function install(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "fakex");
  writeFileSync(bin, `#!/bin/sh\necho "fakex-cli ${version}"\n`);
  chmodSync(bin, 0o755);
  tick += 10;
  utimesSync(bin, tick, tick);
  return bin;
}

const nvmDir = path.join(root, "nvm", "bin");
const localDir = path.join(root, "local", "bin");
const brewDir = path.join(root, "brew", "bin");
const hints = { binaryNames: ["fakex"], wellKnownDirs: [brewDir] };

test("the newest installed copy wins over PATH order, and the pin caches the installed set", async () => {
  const old = install(nvmDir, "0.147.0");
  const fresh = install(localDir, "0.159.0");
  // The older copy comes first on PATH; one dir is listed twice.
  process.env["PATH"] = [nvmDir, localDir, localDir].join(path.delimiter);

  const pin = await resolvePin("fakex", hints);
  assert.ok(pin !== null);
  assert.equal(pin.binPath, fresh);
  assert.equal(pin.version, "fakex-cli 0.159.0");
  assert.deepEqual(pin.candidates.map((c) => c.binPath), [old, fresh], "duplicates collapse, hunt order kept");

  // Nothing changed: the cached pin comes back unchanged.
  const again = await resolvePin("fakex", hints);
  assert.ok(again !== null);
  assert.equal(again.checkedAt, pin.checkedAt);

  // A newer copy in a well-known dir that is not on PATH wins.
  const brew = install(brewDir, "0.160.2");
  const third = await resolvePin("fakex", hints);
  assert.ok(third !== null);
  assert.equal(third.binPath, brew);
  assert.notEqual(third.checkedAt, pin.checkedAt);

  // The older copy is upgraded in place past the others.
  install(nvmDir, "1.0.0");
  const upgraded = await resolvePin("fakex", hints);
  assert.ok(upgraded !== null);
  assert.equal(upgraded.binPath, old);
  assert.equal(upgraded.version, "fakex-cli 1.0.0");

  // The winner is removed: next newest.
  rmSync(old);
  const afterRemove = await resolvePin("fakex", hints);
  assert.ok(afterRemove !== null);
  assert.equal(afterRemove.binPath, brew);

  // Everything removed: not installed, pin dropped.
  rmSync(fresh);
  rmSync(brew);
  assert.equal(await resolvePin("fakex", hints), null);
});

test("a symlink alias is the same candidate; a tie keeps PATH order; unparsable versions lose", async () => {
  const a = path.join(root, "tie-a");
  const b = path.join(root, "tie-b");
  const c = path.join(root, "tie-c");
  const first = install(a, "2.0.0");
  install(b, "2.0.0");
  mkdirSync(c, { recursive: true });
  symlinkSync(first, path.join(c, "fakex"));
  const junkDir = path.join(root, "junk");
  mkdirSync(junkDir, { recursive: true });
  const junk = path.join(junkDir, "fakex");
  writeFileSync(junk, "#!/bin/sh\necho 'development build'\n");
  chmodSync(junk, 0o755);
  process.env["PATH"] = [junkDir, c, a, b].join(path.delimiter);

  const pin = await resolvePin("tie", { binaryNames: ["fakex"], wellKnownDirs: [] });
  assert.ok(pin !== null);
  // The symlink in c is the first spelling of the file in a; b is a distinct file of the same version.
  assert.equal(pin.candidates.length, 3, "junk, c(=a), b");
  assert.equal(pin.binPath, path.join(c, "fakex"), "first spelling of the newest, in PATH order");
  assert.equal(pin.candidates[0]?.version, "development build");
});
