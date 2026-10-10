/**
 * Fix persisted chat model id: ollamacode.ollama-agent/X → ollamacode/X
 * VS Code 1.140 stores vendor/id; EDH sometimes wrote extensionId/id.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dbPath = path.join(root, ".userdata-oss", "User", "globalStorage", "state.vscdb");
const BAD = /ollamacode\.ollama-agent\//gi;
const GOOD = "ollamacode/";

function loadSqlite3() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(root, ".cache", "vscode-140", "node_modules", "@vscode", "sqlite3"),
    path.join(root, ".cache", "vscode", "node_modules", "@vscode", "sqlite3"),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  return null;
}

function allAsync(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function migrate() {
  if (!fs.existsSync(dbPath)) {
    console.log("no state.vscdb yet — skip");
    return;
  }
  const sqlite3 = loadSqlite3();
  if (!sqlite3) {
    console.warn("sqlite3 not found — skip model key migrate");
    return;
  }

  const db = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(d)));
  });

  try {
    // Scan all string values — conversation drafts also embed the model id
    const rows = await allAsync(
      db,
      "SELECT key, value FROM ItemTable WHERE typeof(value) = 'text' AND value LIKE '%ollamacode.ollama-agent/%'"
    );
    let n = 0;
    for (const row of rows) {
      const v = String(row.value ?? "");
      if (!BAD.test(v)) continue;
      BAD.lastIndex = 0;
      const next = v.replace(BAD, GOOD);
      await runAsync(db, "UPDATE ItemTable SET value = ? WHERE key = ?", [next, row.key]);
      n++;
      console.log(`migrate ${row.key}`);
    }

    const modelKeys = await allAsync(
      db,
      "SELECT key, value FROM ItemTable WHERE key LIKE 'chat.currentLanguageModel%'"
    );
    for (const row of modelKeys) {
      if (String(row.key).endsWith(".isDefault")) {
        await runAsync(db, "DELETE FROM ItemTable WHERE key = ?", [row.key]);
        n++;
        console.log(`clear auto-default flag ${row.key}`);
      }
    }

    const pref = modelKeys.find((r) => r.key === "chat.currentLanguageModel.panel");
    const prefVal = pref ? String(pref.value) : "";
    if (!pref || prefVal.includes("ollamacode.ollama-agent/") || !prefVal.startsWith("ollamacode/")) {
      await runAsync(
        db,
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["chat.currentLanguageModel.panel", "ollamacode/agent35:latest"]
      );
      n++;
      console.log("set chat.currentLanguageModel.panel = ollamacode/agent35:latest");
    }
    console.log(n ? `✓ migrated ${n} chat model keys` : "· chat model keys ok");
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

migrate().catch((e) => {
  console.warn("migrate-chat-model-storage:", e?.message || e);
  process.exitCode = 0;
});
