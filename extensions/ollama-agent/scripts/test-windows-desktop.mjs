/**
 * Live harness for windows-ui.ps1 (no VS Code). Run:
 *   node scripts/test-windows-desktop.mjs
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ps1 = path.join(__dirname, "..", "scripts", "windows-ui.ps1");

function call(payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error("timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(t);
      let json = null;
      try {
        json = JSON.parse(stdout.trim().replace(/^\uFEFF/, "") || "{}");
      } catch (e) {
        json = { ok: false, error: `bad json: ${e.message}`, raw: stdout.slice(0, 500) };
      }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.write(Buffer.from(JSON.stringify(payload), "utf8"));
    child.stdin.end();
  });
}

let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    failed++;
    console.error(`✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

const results = {};

results.snapshot = await call({ action: "snapshot" });
ok("snapshot ok", results.snapshot.json?.ok === true, results.snapshot.json?.error);
ok(
  "snapshot has windows",
  (results.snapshot.json?.windows?.length || 0) > 0,
  `count=${results.snapshot.json?.windows?.length}`
);

results.tgSnap = await call({ action: "snapshot", process: "Telegram" });
ok("telegram snapshot ok", results.tgSnap.json?.ok === true);
ok(
  "telegram process_alive or match",
  results.tgSnap.json?.process_alive === true || Number(results.tgSnap.json?.match?.hwnd) > 0,
  JSON.stringify({
    alive: results.tgSnap.json?.process_alive,
    match: results.tgSnap.json?.match,
  })
);

const hwnd = Number(results.tgSnap.json?.match?.hwnd || 0);
ok("telegram match hwnd", hwnd > 0, JSON.stringify(results.tgSnap.json?.match));

if (hwnd) {
  results.focus = await call({ action: "focus", hwnd });
  ok("focus telegram ok", results.focus.json?.ok === true, results.focus.json?.error);
  ok(
    "focus process is Telegram",
    /telegram/i.test(String(results.focus.json?.process || "")),
    results.focus.json?.process
  );
  // focused OR restored is success (OS may deny foreground while Cursor is active)
  ok(
    "focus restored or focused",
    results.focus.json?.focused === true || results.focus.json?.restored === true,
    JSON.stringify({
      focused: results.focus.json?.focused,
      restored: results.focus.json?.restored,
    })
  );

  results.tree = await call({ action: "ui_tree", hwnd, max_depth: 3, focus: false });
  ok("ui_tree ok", results.tree.json?.ok === true, results.tree.json?.error);
  ok(
    "ui_tree has nodes OR process telegram",
    (results.tree.json?.node_count || 0) > 0 ||
      /telegram/i.test(String(results.tree.json?.process || "")),
    `nodes=${results.tree.json?.node_count} proc=${results.tree.json?.process}`
  );
}

results.list = await call({ action: "list_windows", process: "Telegram" });
ok(
  "list_windows telegram",
  (results.list.json?.windows?.length || 0) >= 1 || results.list.json?.count >= 1,
  `count=${results.list.json?.count}`
);

results.closeRefuse = await call({ action: "close", process: "Telegram" });
ok(
  "close telegram refused",
  results.closeRefuse.json?.ok === false &&
    /REFUSED|protected/i.test(String(results.closeRefuse.json?.error || "")),
  results.closeRefuse.json?.error
);

results.keysRefuse = await call({
  action: "keys",
  process: "Telegram",
  keys: "%{F4}",
});
ok(
  "Alt+F4 refused",
  results.keysRefuse.json?.ok === false &&
    /REFUSED|blocked|quit|protected/i.test(String(results.keysRefuse.json?.error || "")),
  results.keysRefuse.json?.error
);

results.ideRefuse = await call({ action: "focus", process: "OllamaCode" });
ok(
  "focus OllamaCode refused OR not found",
  results.ideRefuse.json?.ok === false ||
    /REFUSED|IDE|not found/i.test(
      String(results.ideRefuse.json?.error || results.ideRefuse.stderr || "")
    ),
  JSON.stringify(results.ideRefuse.json).slice(0, 200)
);

const outDir = path.join(__dirname, "..", "..", "..", ".cache");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "windows-desktop-live.json"),
  JSON.stringify(
    {
      snapshot_count: results.snapshot.json?.windows?.length,
      tg_match: results.tgSnap.json?.match,
      process_alive: results.tgSnap.json?.process_alive,
      tip: results.tgSnap.json?.tip,
      focus: results.focus?.json,
      tree_nodes: results.tree?.json?.node_count,
    },
    null,
    2
  ),
  "utf8"
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll windows_desktop live checks passed");
