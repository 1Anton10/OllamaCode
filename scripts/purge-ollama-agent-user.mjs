/**
 * Remove user-installed ollamacode.ollama-agent so only the system/builtin
 * copy under OSS extensions/ is used. User installs cause "Restart Required".
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const extRoot = path.join(root, ".userdata-oss", "extensions");

if (!fs.existsSync(extRoot)) {
  console.log("· no user extensions dir");
  process.exit(0);
}

let removed = 0;
for (const name of fs.readdirSync(extRoot)) {
  if (!/^ollamacode\.ollama-agent/i.test(name) && name !== "extensions.json") {
    continue;
  }
  const full = path.join(extRoot, name);
  if (name === "extensions.json") {
    try {
      const list = JSON.parse(fs.readFileSync(full, "utf8"));
      if (!Array.isArray(list)) continue;
      const next = list.filter(
        (e) => (e?.identifier?.id || "").toLowerCase() !== "ollamacode.ollama-agent"
      );
      if (next.length !== list.length) {
        fs.writeFileSync(full, JSON.stringify(next, null, 2));
        removed++;
        console.log("✓ scrubbed ollamacode from extensions.json");
      }
      if (next.length === 0) {
        fs.unlinkSync(full);
      }
    } catch {
      /* ignore */
    }
    continue;
  }
  try {
    fs.rmSync(full, { recursive: true, force: true });
    removed++;
    console.log("✓ removed user extension", name);
  } catch (e) {
    console.warn("⚠ could not remove", name, e?.message || e);
  }
}

if (!removed) {
  console.log("· no user ollama-agent to purge");
}
