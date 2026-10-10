/**
 * Chat filetree UX: folders start collapsed + capped height with scroll.
 * Patches out-fast workbench bundle + CSS, and OSS src/out when present.
 *
 *   node scripts/_patch-chat-filetree.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MARKER = "OLLAMACODE_CHAT_FILETREE_CAP";
const MAX_H = 198; // ~8–9 rows @ 22px

function patchText(file, apply) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, "utf8");
  if (before.includes(MARKER)) {
    console.log(`· already ${path.relative(root, file)}`);
    return true;
  }
  const after = apply(before);
  if (!after || after === before) {
    console.warn(`⚠ no match ${path.relative(root, file)}`);
    return false;
  }
  fs.writeFileSync(file, after);
  console.log(`✓ ${path.relative(root, file)}`);
  return true;
}

function patchBundle(file) {
  return patchText(file, (t) => {
    let out = t;
    // Prefer ChatListTreeDataSource factory (unique)
    const collapseRe =
      /ChatListTreeDataSource\(\),\s*\{\s*collapseByDefault:\s*\(\)\s*=>\s*false,\s*expandOnlyOnTwistieClick:\s*\(\)\s*=>\s*false,/;
    if (!collapseRe.test(out)) return null;
    out = out.replace(
      collapseRe,
      `ChatListTreeDataSource(),\n      {\n        collapseByDefault: () => true, /* ${MARKER} */\n        expandOnlyOnTwistieClick: () => false,`
    );

    const setRe =
      /this\.tree\.setInput\(data\)\.then\(\(\)\s*=>\s*\{\s*if\s*\(!ref\.isStale\(\)\)\s*\{\s*this\.tree\.layout\(\);\s*\}\s*\}\);/;
    if (!setRe.test(out)) return null;
    out = out.replace(
      setRe,
      `this.tree.setInput(data).then(() => { if (!ref.isStale()) { /* ${MARKER} */ const maxH=${MAX_H}; const contentH=typeof this.tree.contentHeight==="number"?this.tree.contentHeight:maxH; const h=Math.max(66,Math.min(contentH||maxH,maxH)); const el=this.tree.getHTMLElement()?.parentElement; if(el){el.style.maxHeight=maxH+"px";el.style.height=h+"px";el.style.overflow="auto";} this.tree.layout(h); this._onDidChangeHeight?.fire?.(); } });`
    );
    return out;
  });
}

function patchCss(file) {
  return patchText(file, (t) => {
    // CRLF or LF, spaces or tabs
    const re =
      /\.interactive-response-progress-tree\s*\{\s*margin:\s*16px 0px;\s*\}/;
    if (!re.test(t)) return null;
    return t.replace(
      re,
      `.interactive-response-progress-tree {\n  margin: 16px 0px;\n  max-height: ${MAX_H}px;\n  overflow: auto;\n} /* ${MARKER} */`
    );
  });
}

function patchTsSource(file) {
  return patchText(file, (t) => {
    let out = t;
    if (!out.includes("collapseByDefault: () => false")) return null;
    out = out.replace(
      "collapseByDefault: () => false,",
      `collapseByDefault: () => true, // ${MARKER}`
    );
    const old =
      "\t\tthis.tree.setInput(data).then(() => {\n\t\t\tif (!ref.isStale()) {\n\t\t\t\tthis.tree.layout();\n\t\t\t\tthis._onDidChangeHeight.fire();\n\t\t\t}\n\t\t});";
    const neu =
      `\t\tthis.tree.setInput(data).then(() => {\n\t\t\tif (!ref.isStale()) {\n\t\t\t\t// ${MARKER}\n\t\t\t\tconst maxH = ${MAX_H};\n\t\t\t\tconst contentH = typeof (this.tree as any).contentHeight === 'number' ? (this.tree as any).contentHeight : maxH;\n\t\t\t\tconst h = Math.max(66, Math.min(contentH || maxH, maxH));\n\t\t\t\tconst el = this.tree.getHTMLElement().parentElement;\n\t\t\t\tif (el) { el.style.maxHeight = \`\${maxH}px\`; el.style.height = \`\${h}px\`; el.style.overflow = 'auto'; }\n\t\t\t\tthis.tree.layout(h);\n\t\t\t\tthis._onDidChangeHeight.fire();\n\t\t\t}\n\t\t});`;
    if (out.includes(old)) out = out.replace(old, neu);
    return out;
  });
}

function patchOutJs(file) {
  return patchText(file, (t) => {
    if (!t.includes("collapseByDefault: () => false")) return null;
    let out = t.replace(
      "collapseByDefault: () => false,",
      `collapseByDefault: () => true, // ${MARKER}`
    );
    const old =
      "this.tree.setInput(data).then(() => {\n            if (!ref.isStale()) {\n                this.tree.layout();\n                this._onDidChangeHeight.fire();\n            }\n        });";
    const neu =
      `this.tree.setInput(data).then(() => {\n            if (!ref.isStale()) {\n                /* ${MARKER} */\n                const maxH = ${MAX_H};\n                const contentH = typeof this.tree.contentHeight === "number" ? this.tree.contentHeight : maxH;\n                const h = Math.max(66, Math.min(contentH || maxH, maxH));\n                const el = this.tree.getHTMLElement().parentElement;\n                if (el) { el.style.maxHeight = maxH + "px"; el.style.height = h + "px"; el.style.overflow = "auto"; }\n                this.tree.layout(h);\n                this._onDidChangeHeight.fire();\n            }\n        });`;
    if (out.includes(old)) out = out.replace(old, neu);
    return out;
  });
}

const targets = [
  path.join(root, ".cache/vscode-140/out-fast/vs/workbench/workbench.desktop.main.js"),
  path.join(root, ".cache/vscode/out-fast/vs/workbench/workbench.desktop.main.js"),
  path.join(root, ".cache/vscode/out/vs/workbench/workbench.desktop.main.js"),
];
const cssTargets = [
  path.join(root, ".cache/vscode-140/out-fast/vs/workbench/workbench.desktop.main.css"),
  path.join(root, ".cache/vscode/out-fast/vs/workbench/workbench.desktop.main.css"),
  path.join(root, ".cache/vscode/src/vs/workbench/contrib/chat/browser/media/chat.css"),
  path.join(root, ".cache/vscode/out/vs/workbench/contrib/chat/browser/media/chat.css"),
];

let ok = 0;
for (const f of targets) if (patchBundle(f)) ok++;
for (const f of cssTargets) if (patchCss(f)) ok++;

const ts = path.join(
  root,
  ".cache/vscode/src/vs/workbench/contrib/chat/browser/chatContentParts/chatTreeContentPart.ts"
);
const outJs = path.join(
  root,
  ".cache/vscode/out/vs/workbench/contrib/chat/browser/chatContentParts/chatTreeContentPart.js"
);
if (fs.existsSync(ts)) {
  const src = fs.readFileSync(ts, "utf8");
  if (src.includes(MARKER)) console.log(`· already chatTreeContentPart.ts`);
  else if (patchTsSource(ts)) ok++;
}
if (fs.existsSync(outJs)) {
  const src = fs.readFileSync(outJs, "utf8");
  if (src.includes(MARKER)) console.log(`· already chatTreeContentPart.js`);
  else if (patchOutJs(outJs)) ok++;
}

console.log(`Done (${ok} files). Full quit LocalCursor to reload workbench bundle.`);
