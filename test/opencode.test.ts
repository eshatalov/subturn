// test/opencode.test.ts — opencode auth and shadow, offline, against a fake
// user opencode.db. No harness is launched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { opencodePlugin, snapshotCredentials } from "../src/plugins/opencode.ts";

const userData = mkdtempSync(path.join(tmpdir(), "subturn-opencode-user-"));
const sessionDir = mkdtempSync(path.join(tmpdir(), "subturn-opencode-session-"));
const scratch = mkdtempSync(path.join(tmpdir(), "subturn-opencode-scratch-"));
const userDb = path.join(userData, "opencode", "opencode.db");
const savedXdg = process.env["XDG_DATA_HOME"];

mkdirSync(path.dirname(userDb), { recursive: true });
{
  const db = new DatabaseSync(userDb);
  // Like the real one: WAL, and foreign keys that cascade between emptied tables.
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
      connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES project(id) ON DELETE CASCADE, directory TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE, data TEXT);
    INSERT INTO credential VALUES
      ('cred_1', 'opencode', 'default', '{"type":"oauth","methodID":"device","refresh":"r1","access":"a1","expires":1}', NULL, NULL, 1, 1, 1),
      ('cred_2', 'zai-coding-plan', 'default', '{"type":"key","key":"k2"}', NULL, NULL, 1, 2, 2);
    INSERT INTO migration VALUES ('m1', 1), ('m2', 2), ('m3', 3);
    INSERT INTO kv VALUES ('models-dev:catalog', '${"x".repeat(100_000)}'), ('wellknown:sources', '[]');
    INSERT INTO project VALUES ('proj_1', '/Users/someone/proj');
    INSERT INTO session_v2 VALUES ('ses_1', 'proj_1', '/Users/someone/proj');
    INSERT INTO session_message VALUES ('msg_1', 'ses_1', 'hi'), ('msg_2', 'ses_1', 'hello');
  `);
  db.close();
}
process.env["XDG_DATA_HOME"] = userData;

test.after(() => {
  if (savedXdg === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = savedXdg;
  for (const d of [userData, sessionDir, scratch]) rmSync(d, { recursive: true, force: true });
});

function query(file: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const count = (file: string, table: string): number =>
  Number(query(file, `SELECT count(*) AS n FROM ${table}`)[0]?.["n"]);

const tableNames = (file: string): string[] =>
  query(file, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => String(r["name"]));

const shadowData = path.join(sessionDir, "home", "opencode-data");
const shadowDb = path.join(shadowData, "opencode", "opencode.db");
const userCounts = (): Record<string, number> =>
  Object.fromEntries(tableNames(userDb).map((t) => [t, count(userDb, t)]));
const userBefore = userCounts();

test("auth reads the provider ids from the credential table", async () => {
  const res = await opencodePlugin.auth();
  assert.equal(res.ok, true, res.detail);
  assert.match(res.detail, /opencode/);
  assert.match(res.detail, /zai-coding-plan/);
});

test("home snapshots credentials into a private DB with session tables emptied", async () => {
  // A live writer holds an open transaction, as the user's service might.
  const writer = new DatabaseSync(userDb);
  writer.exec("BEGIN; INSERT INTO credential (id, integration_id) VALUES ('cred_uncommitted', 'x')");
  let home: Awaited<ReturnType<typeof opencodePlugin.home>>;
  try {
    home = await opencodePlugin.home(sessionDir);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  assert.ok(existsSync(shadowDb));
  assert.equal(home.env["XDG_DATA_HOME"], shadowData);
  assert.equal(home.env["OPENCODE_DB"], shadowDb);
  assert.equal(home.env["OPENCODE_PRINT_LOGS"], "1");

  const creds = "SELECT id, integration_id FROM credential ORDER BY id";
  assert.deepEqual(query(shadowDb, creds), query(userDb, creds));
  const values = query(shadowDb, "SELECT value FROM credential ORDER BY id").map((r) => JSON.parse(String(r["value"])));
  assert.deepEqual(values, [
    { type: "oauth", methodID: "device", refresh: "", access: "a1", expires: 1 },
    { type: "key", key: "k2" },
  ]);
  assert.equal(count(shadowDb, "migration"), count(userDb, "migration"));
  const keys = query(shadowDb, "SELECT key FROM kv ORDER BY key").map((r) => r["key"]);
  assert.deepEqual(keys, ["wellknown:sources"]);
  for (const t of ["session_v2", "session_message", "project"]) {
    assert.equal(count(shadowDb, t), 0, `${t} must be emptied`);
  }
  assert.deepEqual(tableNames(shadowDb), tableNames(userDb), "no table may be dropped");
});

test("home on a resumed turn leaves the existing shadow alone", async () => {
  const db = new DatabaseSync(shadowDb);
  db.exec("INSERT INTO project VALUES ('p', '/tmp'); INSERT INTO session_v2 VALUES ('ses_marker', 'p', '/tmp')");
  db.close();
  const home = await opencodePlugin.home(sessionDir);
  assert.equal(count(shadowDb, "session_v2"), 1);
  assert.equal(query(shadowDb, "SELECT id FROM session_v2")[0]?.["id"], "ses_marker");
  assert.match(home.note, /existing shadow reused/);
});

test("the user's DB is untouched", () => {
  assert.deepEqual(userCounts(), userBefore);
});

async function authWith(dataHome: string): Promise<{ ok: boolean; detail: string }> {
  process.env["XDG_DATA_HOME"] = dataHome;
  try {
    return await opencodePlugin.auth();
  } finally {
    process.env["XDG_DATA_HOME"] = userData;
  }
}

test("OPENCODE_DB names the user's DB and never reaches the child", async () => {
  const elsewhere = mkdtempSync(path.join(scratch, "override-"));
  const moved = path.join(elsewhere, "mine.db");
  const src = new DatabaseSync(userDb, { readOnly: true });
  src.prepare("VACUUM INTO ?").run(moved);
  src.close();
  const session = mkdtempSync(path.join(scratch, "override-session-"));
  process.env["XDG_DATA_HOME"] = mkdtempSync(path.join(scratch, "override-empty-"));
  process.env["OPENCODE_DB"] = moved;
  try {
    const res = await opencodePlugin.auth();
    assert.equal(res.ok, true, res.detail);
    const home = await opencodePlugin.home(session);
    const shadow = path.join(session, "home", "opencode-data", "opencode", "opencode.db");
    assert.equal(home.env["OPENCODE_DB"], shadow);
    assert.equal(count(shadow, "credential"), 2);
    assert.equal(count(shadow, "session_v2"), 0);
  } finally {
    delete process.env["OPENCODE_DB"];
    process.env["XDG_DATA_HOME"] = userData;
  }
});

test("auth without opencode.db points at opencode auth login", async () => {
  const empty = mkdtempSync(path.join(scratch, "empty-"));
  const res = await authWith(empty);
  assert.equal(res.ok, false);
  assert.match(res.detail, /opencode auth login/);
});

test("auth with an empty credential table points at opencode auth login", async () => {
  const dir = mkdtempSync(path.join(scratch, "nocreds-"));
  mkdirSync(path.join(dir, "opencode"));
  const db = new DatabaseSync(path.join(dir, "opencode", "opencode.db"));
  db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT)");
  db.close();
  const res = await authWith(dir);
  assert.equal(res.ok, false);
  assert.match(res.detail, /opencode auth login/);
});

test("auth on a DB without a credential table says it cannot read credentials", async () => {
  const dir = mkdtempSync(path.join(scratch, "nocredtable-"));
  mkdirSync(path.join(dir, "opencode"));
  const db = new DatabaseSync(path.join(dir, "opencode", "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
  db.close();
  const res = await authWith(dir);
  assert.equal(res.ok, false);
  assert.match(res.detail, /^cannot read credentials/);
});

test("emptying a table never cascades into kept credentials", () => {
  const dir = mkdtempSync(path.join(scratch, "cascade-"));
  const src = path.join(dir, "user.db");
  const db = new DatabaseSync(src);
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE project (id TEXT PRIMARY KEY);
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT,
      project_id TEXT REFERENCES project(id) ON DELETE CASCADE);
    INSERT INTO project VALUES ('p1');
    INSERT INTO credential VALUES ('c1', 'opencode', '{"type":"key","key":"k"}', 'p1'), ('c2', 'zai-coding-plan', '{"type":"key","key":"k"}', 'p1');
  `);
  db.close();
  const out = path.join(dir, "shadow", "opencode.db");
  snapshotCredentials(src, out);
  assert.equal(count(out, "credential"), 2);
  assert.equal(count(out, "project"), 0);
});

test("a failed snapshot leaves no shadow behind", () => {
  const dir = mkdtempSync(path.join(scratch, "failed-"));
  const src = path.join(dir, "user.db");
  writeFileSync(src, "not a database");
  const out = path.join(dir, "shadow", "opencode.db");
  assert.throws(() => snapshotCredentials(src, out));
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(`${out}.tmp`), false);
});
