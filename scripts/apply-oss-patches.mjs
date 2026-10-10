/**
 * Apply OllamaCode source patches to Code-OSS tree (1.140+).
 * Usage: node scripts/apply-oss-patches.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { syncOllamaAgent } from "./sync-ollama-agent.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function resolveOss() {
  const preferred = path.join(root, ".cache", "vscode-140");
  const legacy = path.join(root, ".cache", "vscode");
  if (fs.existsSync(path.join(preferred, "package.json"))) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(preferred, "package.json"), "utf8")).version;
      console.log(`OSS tree: ${preferred} (v${v})`);
    } catch {
      /* ignore */
    }
    return preferred;
  }
  return legacy;
}

const oss = resolveOss();
function mustExist(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing: ${p}`);
}
mustExist(oss);

// 1) product.json overlay
const productPath = path.join(oss, "product.json");
const overlay = JSON.parse(fs.readFileSync(path.join(root, "ide", "product.json"), "utf8"));
const base = JSON.parse(fs.readFileSync(productPath, "utf8"));
const keys = [
  "nameShort", "nameLong", "applicationName", "dataFolderName", "urlProtocol",
  "win32MutexName", "win32DirName", "win32NameVersion", "win32RegValueName",
  "win32AppUserModelId", "win32ShellNameShort", "win32AppId", "win32x64AppId",
  "win32arm64AppId", "win32x64UserAppId", "win32arm64UserAppId",
  "win32TunnelServiceMutex", "win32TunnelMutex",
  "serverApplicationName", "serverDataFolderName", "tunnelApplicationName",
  "darwinBundleIdentifier", "linuxIconName", "enableTelemetry", "aiConfig",
  "defaultChatAgent", "extensionsGallery", "extensionEnabledApiProposals",
  "linkProtectionTrustedDomains", "reportIssueUrl", "licenseName", "licenseUrl",
  "trustedExtensionAuthAccess", "builtInExtensionsEnabledWithAutoUpdates",
  "voiceWsUrl", "agentsTelemetryAppName", "npsSurveyUrl", "surveys",
];
for (const k of keys) {
  if (overlay[k] !== undefined) base[k] = overlay[k];
}
// Privacy: never ship Microsoft telemetry / voice / NPS endpoints
base.enableTelemetry = false;
base.aiConfig = { ...(base.aiConfig || {}), ariaKey: "" };
base.voiceWsUrl = "";
base.agentsTelemetryAppName = "";
base.npsSurveyUrl = "";
base.surveys = [];
delete base.updateUrl;
delete base.extensionTipsSupportUrl;
delete base.experimentsUrl;
// Scrub leftover Copilot gallery identity even if overlay omitted a key
if (!overlay.trustedExtensionAuthAccess) {
  base.trustedExtensionAuthAccess = {
    microsoft: ["vscode.github-authentication"],
  };
}
if (!Array.isArray(base.builtInExtensionsEnabledWithAutoUpdates)) {
  base.builtInExtensionsEnabledWithAutoUpdates = [];
} else {
  base.builtInExtensionsEnabledWithAutoUpdates = base.builtInExtensionsEnabledWithAutoUpdates.filter(
    (id) => !/copilot/i.test(String(id))
  );
}
fs.writeFileSync(productPath, JSON.stringify(base, null, "\t") + "\n");
console.log("✓ product.json → OllamaCode");

// 2) Sync ollama-agent into OSS extensions/ as a REAL directory (junctions are skipped by scanner on Windows)
// Content-hash sync (NOT robocopy /XO): /XO skipped updates when dest mtime was newer,
// so restarts intermittently kept stale extension code.
const agentSync = syncOllamaAgent({ bump: true });
if (!fs.existsSync(path.join(agentSync.dest, "package.json"))) {
  throw new Error("Failed to sync extensions/ollama-agent into OSS tree");
}
console.log(
  agentSync.written > 0
    ? `✓ extensions/ollama-agent synced (${agentSync.written} files) v${agentSync.version}`
    : `· extensions/ollama-agent already in sync (v${agentSync.version})`
);

// 2a) Quarantine built-in Copilot chat so Agent panel is Ollama-only
const copilotDir = path.join(oss, "extensions", "copilot");
const copilotOff = path.join(oss, "extensions", "copilot.DISABLED");
if (fs.existsSync(copilotDir) && !fs.existsSync(copilotOff)) {
  fs.renameSync(copilotDir, copilotOff);
  console.log("✓ extensions/copilot quarantined");
} else if (fs.existsSync(copilotOff)) {
  console.log("· extensions/copilot already quarantined");
}

// 2b) Spectre off + delayimp.lib path (VS2026 BuildTools often omits LIB for node-gyp)
const msvcLib =
  process.env.OLLAMACODE_MSVC_LIB ||
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Tools\\MSVC\\14.51.36231\\lib\\x64";
fs.writeFileSync(
  path.join(oss, "Directory.Build.props"),
  `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <PropertyGroup>
    <SpectreMitigation>false</SpectreMitigation>
  </PropertyGroup>
  <ItemDefinitionGroup>
    <Link>
      <AdditionalLibraryDirectories>${msvcLib};%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>
</Project>
`
);
fs.writeFileSync(
  path.join(oss, "Directory.Build.targets"),
  `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <PropertyGroup>
    <SpectreMitigation>false</SpectreMitigation>
  </PropertyGroup>
</Project>
`
);
console.log("✓ Directory.Build.props/targets (no Spectre)");

const sqliteGyp = path.join(oss, "node_modules", "@vscode", "sqlite3", "binding.gyp");
if (fs.existsSync(sqliteGyp)) {
  let gyp = fs.readFileSync(sqliteGyp, "utf8");
  if (gyp.includes('"SpectreMitigation": "Spectre"')) {
    gyp = gyp.replace('"SpectreMitigation": "Spectre"', '"SpectreMitigation": "false"');
    fs.writeFileSync(sqliteGyp, gyp);
    console.log("✓ @vscode/sqlite3 Spectre off");
  }
}

// 3) Skip Copilot chat setup agents — keep native Agent/Models panel for ollamacode
const setupContrib = path.join(
  oss,
  "src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts"
);
if (fs.existsSync(setupContrib)) {
  let cs = fs.readFileSync(setupContrib, "utf8");
  let changed = false;
  if (!cs.includes("OLLAMACODE_NO_COPILOT_SETUP")) {
    const needle = `private registerSetupAgents(context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): void {`;
    if (cs.includes(needle)) {
      cs = cs.replace(
        needle,
        `private registerSetupAgents(context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): void {
		// OLLAMACODE_NO_COPILOT_SETUP — use built-in Agent chat with ollama-agent, never Copilot setup chrome
		if (product.defaultChatAgent?.extensionId === 'ollamacode.ollama-agent') {
			return;
		}`
      );
      if (!cs.includes("@IProductService") && cs.includes("constructor(")) {
        console.warn("· chatSetupContributions: ensure IProductService is injected (manual check)");
      }
      changed = true;
      console.log("✓ chatSetupContributions: skip Copilot setup agents");
    } else {
      console.warn("⚠ registerSetupAgents anchor not found");
    }
  } else {
    console.log("· chatSetup skip already present");
  }
  if (!cs.includes("OLLAMACODE_NO_SIGNIN_TITLEBAR")) {
    const signInNeedle = `this.registerSignInTitleBarEntry(actionViewItemService);`;
    if (cs.includes(signInNeedle)) {
      cs = cs.replace(
        signInNeedle,
        `// OLLAMACODE_NO_SIGNIN_TITLEBAR — local Ollama, never Copilot title-bar Sign In
		if (product.defaultChatAgent?.extensionId !== 'ollamacode.ollama-agent') {
			this.registerSignInTitleBarEntry(actionViewItemService);
		}`
      );
      changed = true;
      console.log("✓ chatSetupContributions: skip Sign In title bar");
    }
  } else {
    console.log("· sign-in title bar skip already present");
  }
  if (!cs.includes("OLLAMACODE_NO_COPILOT_SETUP_ACTIONS")) {
    const actionsNeedle = `private registerActions(context: ChatEntitlementContext, requests: ChatEntitlementRequests, controller: Lazy<ChatSetupController>): void {`;
    if (cs.includes(actionsNeedle)) {
      cs = cs.replace(
        actionsNeedle,
        `private registerActions(context: ChatEntitlementContext, requests: ChatEntitlementRequests, controller: Lazy<ChatSetupController>): void {
		// OLLAMACODE_NO_COPILOT_SETUP_ACTIONS — hide Copilot command-palette setup chrome
		if (product.defaultChatAgent?.extensionId === 'ollamacode.ollama-agent') {
			return;
		}`
      );
      changed = true;
      console.log("✓ chatSetupContributions: skip Copilot setup actions");
    }
  } else {
    console.log("· setup actions skip already present");
  }
  if (changed) {
    fs.writeFileSync(setupContrib, cs);
  }
} else {
  console.warn("⚠ chatSetupContributions.ts missing");
}

// 3b) Terminal: replace Copilot CLI hint with Ollama Models hint
{
  const files = [
    path.join(oss, "src/vs/workbench/contrib/terminalContrib/inlineHint/browser/terminal.initialHint.contribution.ts"),
    path.join(oss, "out/vs/workbench/contrib/terminalContrib/inlineHint/browser/terminal.initialHint.contribution.js"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE_NO_COPILOT_CLI_HINT")) {
      console.log("· no-copilot-cli-hint already in " + path.relative(oss, file));
      continue;
    }
    if (!s.includes('product/common/product')) {
      if (file.endsWith(".ts")) {
        s = s.replace(
          `import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';`,
          `import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';\nimport product from '../../../../../platform/product/common/product.js';`
        );
      } else {
        s = s.replace(
          `import { IChatEntitlementService } from "../../../../services/chat/common/chatEntitlementService.js";`,
          `import { IChatEntitlementService } from "../../../../services/chat/common/chatEntitlementService.js";\nimport product from "../../../../../platform/product/common/product.js";`
        );
      }
    }
    const needleTs = `		// Copilot CLI hint (only shown when AI features are enabled)
		if (!aiFeaturesHidden) {`;
    const needleJs = `    if (!aiFeaturesHidden) {`;
    if (file.endsWith(".ts") && s.includes(needleTs)) {
      // Already hand-patched shape may differ; skip if isOllamaCode present
      if (!s.includes("isOllamaCode")) {
        console.warn("⚠ terminal hint TS shape changed — apply manually");
      }
    } else if (file.endsWith(".js") && s.includes(needleJs) && !s.includes("isOllamaCode")) {
      console.warn("⚠ terminal hint JS still has Copilot block — apply manually if needed");
    }
    if (s.includes("OLLAMACODE_NO_COPILOT_CLI_HINT") || s.includes("isOllamaCode")) {
      if (!s.includes("OLLAMACODE_NO_COPILOT_CLI_HINT") && s.includes("isOllamaCode")) {
        // marker already via comment in patched source
      }
      fs.writeFileSync(file, s);
      console.log("· terminal hint product import ok → " + path.relative(oss, file));
    }
  }
}

const entitlementCandidates = [
  path.join(oss, "src/vs/workbench/services/chat/common/chatEntitlementService.ts"),
  path.join(oss, "src/vs/workbench/contrib/chat/common/chatEntitlementService.ts"),
];
for (const entFile of entitlementCandidates) {
  if (!fs.existsSync(entFile)) continue;
  let ent = fs.readFileSync(entFile, "utf8");
  if (ent.includes("OLLAMACODE_CHAT_INSTALLED")) {
    console.log("· entitlement installed patch already present");
    break;
  }
  // Soft: if checkExtensionInstallation exists, force installed for ollamacode
  if (ent.includes("checkExtensionInstallation") || ent.includes("defaultChat.extensionId")) {
    const marker = "private async checkExtensionInstallation";
    // Many shapes; log for follow-up if no easy anchor
    if (ent.includes("ollamacode.ollama-agent")) {
      console.log("· entitlement already references ollamacode");
    } else {
      console.log(`· entitlement file present (${path.basename(entFile)}) — install force applied via product.defaultChatAgent`);
    }
  }
  break;
}

// 5) Accounts filter (best-effort)
const accountsFile = path.join(oss, "src/vs/workbench/browser/parts/globalCompositeBar.ts");
if (fs.existsSync(accountsFile)) {
  let af = fs.readFileSync(accountsFile, "utf8");
  if (!af.includes("OLLAMACODE_ACCOUNTS_FILTER") && af.includes("otherCommands.forEach")) {
    af = af.replace(
      /otherCommands\.forEach\(\(group, i\) => \{\r?\n\t\t\tconst actions = group\[1\];/,
      `otherCommands.forEach((group, i) => {
			// OLLAMACODE_ACCOUNTS_FILTER
			const actions = group[1].filter(a => {
				const id = (a.id || '').toLowerCase();
				const label = (a.label || '').toLowerCase();
				return !/sync|tunnel|copilot|chatgpt|openai|backup and sync|cloud changes|remote tunnel/.test(id + ' ' + label);
			});`
    );
    if (af.includes("OLLAMACODE_ACCOUNTS_FILTER")) {
      fs.writeFileSync(accountsFile, af);
      console.log("✓ Accounts menu filter");
    } else {
      console.warn("⚠ Accounts filter patch failed");
    }
  } else {
    console.log("· Accounts filter already present or anchor missing");
  }
}

// 6) Persist Ollama model selection across reload (EDH id ↔ vendor/id + empty-catalog race)
function patchFile(rel, marker, apply) {
  const p = path.join(oss, rel);
  if (!fs.existsSync(p)) {
    console.warn(`⚠ missing ${rel}`);
    return;
  }
  let s = fs.readFileSync(p, "utf8");
  if (s.includes(marker)) {
    console.log(`· ${path.basename(rel)} already patched`);
    return;
  }
  const next = apply(s);
  if (next === s || !next.includes(marker)) {
    console.warn(`⚠ ${rel} patch failed`);
    return;
  }
  fs.writeFileSync(p, next);
  console.log(`✓ ${rel}`);
}

patchFile(
  "src/vs/workbench/contrib/chat/common/modelSelection.ts",
  "normalizeOllamaCodeModelId",
  (s) => {
    if (s.includes("normalizeOllamaCodeModelId")) return s;
    return s.replace(
      `/** Resolves a requested model identifier against the current model catalog. */
export function resolveModelIdentifier(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	identifier: string | undefined,
	isAbsenceConclusive: boolean,
): ModelIdentifierResolution {
	if (!identifier) {
		return { kind: 'notRequested' };
	}

	const model = models.find(model => model.identifier === identifier);
	if (model) {
		return { kind: 'available', model };
	}

	return isAbsenceConclusive
		? { kind: 'unavailable', identifier }
		: { kind: 'pending', identifier };
}`,
      `/** EDH wrote extensionId/id; 1.140 languageModelChatProviders use vendor/id. */
function normalizeOllamaCodeModelId(identifier: string): string {
	return identifier.replace(/^ollamacode\\.ollama-agent\\//i, 'ollamacode/');
}

function findModelByIdentifier(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	identifier: string,
): ILanguageModelChatMetadataAndIdentifier | undefined {
	const exact = models.find(model => model.identifier === identifier);
	if (exact) {
		return exact;
	}
	const normalized = normalizeOllamaCodeModelId(identifier);
	if (normalized !== identifier) {
		return models.find(model => model.identifier === normalized || normalizeOllamaCodeModelId(model.identifier) === normalized);
	}
	return models.find(model => normalizeOllamaCodeModelId(model.identifier) === normalized);
}

/** Resolves a requested model identifier against the current model catalog. */
export function resolveModelIdentifier(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	identifier: string | undefined,
	isAbsenceConclusive: boolean,
): ModelIdentifierResolution {
	if (!identifier) {
		return { kind: 'notRequested' };
	}

	const model = findModelByIdentifier(models, identifier);
	if (model) {
		return { kind: 'available', model };
	}

	return isAbsenceConclusive
		? { kind: 'unavailable', identifier }
		: { kind: 'pending', identifier };
}`
    ).replace(
      `	if (!identifier) {
		return { kind: 'notRequested' };
	}

	const separator = identifier.search(/[/:]/);
	const vendor = separator === -1 ? undefined : identifier.substring(0, separator);
	const hasLive = vendor ? vendorResolution.hasLiveModels(vendor) : false;`,
      `	if (!identifier) {
		return { kind: 'notRequested' };
	}

	// OLLAMACODE: normalize EDH extensionId/id <-> vendor/id before vendor lookup
	identifier = normalizeOllamaCodeModelId(identifier);

	const separator = identifier.search(/[/:]/);
	const vendor = separator === -1 ? undefined : identifier.substring(0, separator);
	const hasLive = vendor ? vendorResolution.hasLiveModels(vendor) : false;`
    );
  }
);

patchFile(
  "src/vs/workbench/contrib/chat/browser/widget/input/chatInputModelUtils.ts",
  "OLLAMACODE: empty catalog",
  (s) =>
    s.replace(
      `	if (!currentModel) {
		return false;
	}

	// Model is no longer in the available list
	if (!availableModels.some(m => m.identifier === currentModel.identifier)) {
		return true;
	}`,
      `	if (!currentModel) {
		return false;
	}

	// OLLAMACODE: empty catalog at reload is transient (BYOK provider still activating).
	// Resetting here flashes the remembered model then clears it to "+ Models".
	if (availableModels.length === 0) {
		return false;
	}

	// Model is no longer in the available list (also accept EDH extensionId/id <-> vendor/id)
	const normalize = (id: string) => id.replace(/^ollamacode\\.ollama-agent\\//i, 'ollamacode/');
	const currentId = normalize(currentModel.identifier);
	if (!availableModels.some(m => m.identifier === currentModel.identifier || normalize(m.identifier) === currentId)) {
		return true;
	}`
    )
);

// 7+8) Quiet Agent Host startup noise (src already patched by hand; keep out/ in sync)
{
  const quietChannelFiles = [
    path.join(oss, "src/vs/base/parts/ipc/common/ipc.ts"),
    path.join(oss, "out/vs/base/parts/ipc/common/ipc.js"),
  ];
  const needle = "console.error(`Unknown channel: ${request.channelName}`);";
  const insert =
    "// OLLAMACODE_QUIET_UNKNOWN_CHANNEL\n" +
    "\t\t\tconst quiet = request.channelName === 'agentHostClientByokLm' || request.channelName === 'agentHostClientProxy' || request.channelName === 'agentHostProxy';\n" +
    "\t\t\tif (!quiet) {\n" +
    "\t\t\t\tconsole.error(`Unknown channel: ${request.channelName}`);\n" +
    "\t\t\t}";
  for (const file of quietChannelFiles) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE_QUIET_UNKNOWN_CHANNEL")) {
      console.log("· quiet unknown channel already in " + path.relative(oss, file));
      continue;
    }
    if (!s.includes(needle)) {
      console.warn("⚠ quiet-channel needle missing: " + path.relative(oss, file));
      continue;
    }
    fs.writeFileSync(file, s.replace(needle, insert));
    console.log("✓ quiet unknown channel → " + path.relative(oss, file));
  }
}
{
  const githubFiles = [
    path.join(oss, "src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.ts"),
    path.join(oss, "out/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.js"),
  ];
  for (const file of githubFiles) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE_QUIET_GITHUB_SESSION")) {
      console.log("· quiet github session already in " + path.relative(oss, file));
      continue;
    }
    const a = "logService.info(`${logPrefix} Authentication provider is not ready for resource: ${resource}; deferring authentication`);";
    const b = "logService.info(`${logPrefix} No signed-in session resolved for resource: ${resource}`);";
    if (!s.includes(b)) {
      console.warn("⚠ github session log missing: " + path.relative(oss, file));
      continue;
    }
    s = s.replace(a, "// OLLAMACODE_QUIET_GITHUB_SESSION\n\t\tlogService.trace(`${logPrefix} Authentication provider is not ready for resource: ${resource}; deferring authentication`);");
    s = s.replace(b, "logService.trace(`${logPrefix} No signed-in session resolved for resource: ${resource}`);");
    fs.writeFileSync(file, s);
    console.log("✓ quiet github session → " + path.relative(oss, file));
  }
}

// 9) Always enable ollamacode.ollama-agent (EDH bypassed enablement; production must too)
{
  const files = [
    path.join(oss, "src/vs/workbench/services/extensions/common/abstractExtensionService.ts"),
    path.join(oss, "out/vs/workbench/services/extensions/common/abstractExtensionService.js"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE_ALWAYS_ENABLE")) {
      console.log("· always-enable already in " + path.relative(oss, file));
      continue;
    }
    const needle = file.endsWith(".ts")
      ? `		if (extension.isUnderDevelopment) {
			// Never disable extensions under development
			enabledExtensions.push(extension);
		} else {
			extensionsToCheck.push(extension);
			mappedExtensions.push(toExtension(extension));
		}`
      : `    if (extension.isUnderDevelopment) {
      enabledExtensions.push(extension);
    } else {
      extensionsToCheck.push(extension);
      mappedExtensions.push(toExtension(extension));
    }`;
    const insert = file.endsWith(".ts")
      ? `		if (extension.isUnderDevelopment) {
			// Never disable extensions under development
			enabledExtensions.push(extension);
		} else if (extension.identifier.value.toLowerCase() === 'ollamacode.ollama-agent') {
			// OLLAMACODE_ALWAYS_ENABLE — local Ollama built-in must run without EDH / Copilot enablement gates
			enabledExtensions.push(extension);
		} else {
			extensionsToCheck.push(extension);
			mappedExtensions.push(toExtension(extension));
		}`
      : `    if (extension.isUnderDevelopment) {
      enabledExtensions.push(extension);
    } else if (extension.identifier.value.toLowerCase() === "ollamacode.ollama-agent") {
      // OLLAMACODE_ALWAYS_ENABLE
      enabledExtensions.push(extension);
    } else {
      extensionsToCheck.push(extension);
      mappedExtensions.push(toExtension(extension));
    }`;
    if (!s.includes(needle.split("\n")[0])) {
      console.warn("⚠ always-enable needle missing: " + path.relative(oss, file));
      continue;
    }
    fs.writeFileSync(file, s.replace(needle, insert));
    console.log("✓ always-enable → " + path.relative(oss, file));
  }
}

// 9b) Never show Restart Required for the built-in ollama-agent (live-edited system ext)
{
  const files = [
    path.join(oss, "src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts"),
    path.join(oss, "out/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.js"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE_NO_RESTART_REQUIRED")) {
      console.log("· no-restart already in " + path.relative(oss, file));
      continue;
    }
    const isTs = file.endsWith(".ts");
    const needle = isTs
      ? `	private getRuntimeState(extension: IExtension): ExtensionRuntimeState | undefined {
		const isUninstalled = extension.state === ExtensionState.Uninstalled;`
      : `  getRuntimeState(extension) {
    const isUninstalled = extension.state === ExtensionState.Uninstalled;`;
    const insert = isTs
      ? `	private getRuntimeState(extension: IExtension): ExtensionRuntimeState | undefined {
		// OLLAMACODE_NO_RESTART_REQUIRED — built-in agent is edited live; never nag Restart Required
		if (extension.identifier.id.toLowerCase() === 'ollamacode.ollama-agent') {
			return undefined;
		}
		const isUninstalled = extension.state === ExtensionState.Uninstalled;`
      : `  getRuntimeState(extension) {
    // OLLAMACODE_NO_RESTART_REQUIRED — built-in agent is edited live; never nag Restart Required
    if (extension.identifier.id.toLowerCase() === "ollamacode.ollama-agent") {
      return void 0;
    }
    const isUninstalled = extension.state === ExtensionState.Uninstalled;`;
    if (!s.includes(needle)) {
      console.warn("⚠ no-restart needle missing: " + path.relative(oss, file));
      continue;
    }
    fs.writeFileSync(file, s.replace(needle, insert));
    console.log("✓ no-restart → " + path.relative(oss, file));
  }
}

// 10) Never auto-disable ollama chat extension on fresh profiles
{
  const files = [
    path.join(oss, "src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts"),
    path.join(oss, "out/vs/workbench/services/extensionManagement/browser/extensionEnablementService.js"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE_NO_DISABLE_CHAT_EXT")) {
      console.log("· no-disable-chat already in " + path.relative(oss, file));
      continue;
    }
    const isTs = file.endsWith(".ts");
    const needle = isTs
      ? `	private ensureChatExtensionInitialDisabledState(): void {
		if (!this._chatExtensionId || this.environmentService.isSessionsWindow || this.environmentService.skipBuiltinExtensions?.some(id => id.toLowerCase() === this._chatExtensionId)) {
			return;
		}`
      : `  ensureChatExtensionInitialDisabledState() {
    if (!this._chatExtensionId || this.environmentService.isSessionsWindow || this.environmentService.skipBuiltinExtensions?.some((id) => id.toLowerCase() === this._chatExtensionId)) {
      return;
    }`;
    const insert = isTs
      ? `	private ensureChatExtensionInitialDisabledState(): void {
		// OLLAMACODE_NO_DISABLE_CHAT_EXT — never auto-disable the local Ollama chat extension
		if (this._chatExtensionId === 'ollamacode.ollama-agent') {
			return;
		}
		if (!this._chatExtensionId || this.environmentService.isSessionsWindow || this.environmentService.skipBuiltinExtensions?.some(id => id.toLowerCase() === this._chatExtensionId)) {
			return;
		}`
      : `  ensureChatExtensionInitialDisabledState() {
    // OLLAMACODE_NO_DISABLE_CHAT_EXT
    if (this._chatExtensionId === "ollamacode.ollama-agent") {
      return;
    }
    if (!this._chatExtensionId || this.environmentService.isSessionsWindow || this.environmentService.skipBuiltinExtensions?.some((id) => id.toLowerCase() === this._chatExtensionId)) {
      return;
    }`;
    if (!s.includes(needle)) {
      console.warn("⚠ no-disable-chat needle missing: " + path.relative(oss, file));
      continue;
    }
    fs.writeFileSync(file, s.replace(needle, insert));
    console.log("✓ no-disable-chat → " + path.relative(oss, file));
  }
}

// 11) Force chat.setupContext installed+enabled for ollamacode (same as EDH path)
{
  const files = [
    path.join(oss, "src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts"),
    path.join(oss, "out/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.js"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE: force chat extension")) {
      console.log("· force-chat-setup already in " + path.relative(oss, file));
      continue;
    }
    const isTs = file.endsWith(".ts");
    const needle = isTs
      ? `		// When developing extensions, await registration and then check
		if (this.environmentService.isExtensionDevelopment) {
			await this.extensionService.whenInstalledExtensionsRegistered();
			if (this.extensionService.extensions.find(ext => ExtensionIdentifier.equals(ext.identifier, defaultChat.chatExtensionId))) {
				context.update({ installed: true, disabled: false, untrusted: false, disabledInWorkspace: false });
				return;
			}
		}`
      : `    if (this.environmentService.isExtensionDevelopment) {
      await this.extensionService.whenInstalledExtensionsRegistered();
      if (this.extensionService.extensions.find((ext) => ExtensionIdentifier.equals(ext.identifier, defaultChat.chatExtensionId))) {
        context.update({ installed: true, disabled: false, untrusted: false, disabledInWorkspace: false });
        return;
      }
    }`;
    const insert = isTs
      ? `		// OLLAMACODE: force chat extension installed+enabled (same as EDH path)
		if (this.environmentService.isExtensionDevelopment || product.defaultChatAgent?.extensionId === 'ollamacode.ollama-agent') {
			await this.extensionService.whenInstalledExtensionsRegistered();
			if (this.extensionService.extensions.find(ext => ExtensionIdentifier.equals(ext.identifier, defaultChat.chatExtensionId))) {
				context.update({ installed: true, disabled: false, untrusted: false, disabledInWorkspace: false });
				return;
			}
			if (product.defaultChatAgent?.extensionId === 'ollamacode.ollama-agent') {
				context.update({ installed: true, disabled: false, untrusted: false, disabledInWorkspace: false });
			}
		}`
      : `    // OLLAMACODE: force chat extension installed+enabled (same as EDH path)
    if (this.environmentService.isExtensionDevelopment || product.defaultChatAgent?.extensionId === "ollamacode.ollama-agent") {
      await this.extensionService.whenInstalledExtensionsRegistered();
      if (this.extensionService.extensions.find((ext) => ExtensionIdentifier.equals(ext.identifier, defaultChat.chatExtensionId))) {
        context.update({ installed: true, disabled: false, untrusted: false, disabledInWorkspace: false });
        return;
      }
      if (product.defaultChatAgent?.extensionId === "ollamacode.ollama-agent") {
        context.update({ installed: true, disabled: false, untrusted: false, disabledInWorkspace: false });
      }
    }`;
    if (!s.includes(needle) && !s.includes("OLLAMACODE: force chat")) {
      // already patched to new form
      if (s.includes("product.defaultChatAgent?.extensionId ===") && s.includes("checkExtensionInstallation")) {
        console.log("· force-chat-setup already present (variant) in " + path.relative(oss, file));
        continue;
      }
      console.warn("⚠ force-chat-setup needle missing: " + path.relative(oss, file));
      continue;
    }
    if (s.includes(needle)) {
      fs.writeFileSync(file, s.replace(needle, insert));
      console.log("✓ force-chat-setup → " + path.relative(oss, file));
    }
  }
}

console.log("\nDone. Next: npm install + electron + compile in", oss);

// 12) Show empty context-usage ring when a model is selected (before first reply)
{
  const files = [
    path.join(oss, "src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts"),
    path.join(oss, "out/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.js"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let s = fs.readFileSync(file, "utf8");
    if (s.includes("OLLAMACODE_CONTEXT_RING_EMPTY")) {
      console.log("· context-ring-empty already in " + path.relative(oss, file));
      continue;
    }
    console.log("· context-ring-empty: ensure applied in source (manual sync if missing): " + path.relative(oss, file));
  }
}

// 12z) Late usage + Session Info fallback in fat bundle
{
  const { spawnSync } = await import("child_process");
  for (const name of ["_patch-late-usage.mjs", "_patch-usage-fallback.mjs"]) {
    const script = path.join(root, "scripts", name);
    if (!fs.existsSync(script)) continue;
    const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
    if (r.status !== 0) console.warn(`⚠ ${name} failed`);
  }
}

// 12a) Hide "installation folder overwritten" banner for OllamaCode source tree
{
  const win = path.join(oss, "src/vs/workbench/electron-browser/window.ts");
  if (fs.existsSync(win)) {
    let s = fs.readFileSync(win, "utf8");
    if (s.includes("OLLAMACODE_NO_APPROOT_BANNER")) {
      console.log("· appRoot banner already suppressed");
    } else if (s.includes("// Installation Dir Warning")) {
      s = s.replace(
        `// Installation Dir Warning
		if (this.environmentService.isBuilt && !this.environmentService.extensionDevelopmentLocationURI?.length) {`,
        `// Installation Dir Warning
		// OLLAMACODE_NO_APPROOT_BANNER — source tree IS the app; banner is noise for local forks
		const isOllamaCodeProduct = /ollama/i.test(this.productService.nameShort || '')
			|| /ollama/i.test(this.productService.applicationName || '');
		if (this.environmentService.isBuilt && !this.environmentService.extensionDevelopmentLocationURI?.length && !isOllamaCodeProduct) {`
      );
      if (s.includes("OLLAMACODE_NO_APPROOT_BANNER")) {
        fs.writeFileSync(win, s);
        console.log("✓ suppress appRoot overwrite banner");
      } else {
        console.warn("⚠ appRoot banner patch failed (shape changed)");
      }
    }
  }
}

// 12b) Bidirectional sync: chat Context chip ↔ ollamaCode settings (OLLAMACODE_BIDIR_CTX)
{
  const bridgeSrc = path.join(root, "ide", "patches", "ollamaCodeModelConfigBridge.ts");
  const bridgeDst = path.join(
    oss,
    "src/vs/workbench/contrib/chat/browser/actions/ollamaCodeModelConfigBridge.ts"
  );
  if (fs.existsSync(bridgeSrc)) {
    fs.mkdirSync(path.dirname(bridgeDst), { recursive: true });
    fs.copyFileSync(bridgeSrc, bridgeDst);
    console.log("✓ ollamaCodeModelConfigBridge.ts");
  } else if (fs.existsSync(bridgeDst) && fs.readFileSync(bridgeDst, "utf8").includes("OLLAMA_BRIDGE_MODEL_CONFIG")) {
    console.log("· bridge already in OSS tree");
  } else {
    console.warn("⚠ bridge source missing — ide/patches/ollamaCodeModelConfigBridge.ts");
  }

  const contrib = path.join(oss, "src/vs/workbench/contrib/chat/browser/chat.contribution.ts");
  if (fs.existsSync(contrib)) {
    let s = fs.readFileSync(contrib, "utf8");
    if (!s.includes("OLLAMACODE_BIDIR_CTX")) {
      if (s.includes("editorChatResponseFileChangesService.js';")) {
        s = s.replace(
          `import { EditorChatResponseFileChangesService } from './editorChatResponseFileChangesService.js';`,
          `import { EditorChatResponseFileChangesService } from './editorChatResponseFileChangesService.js';\nimport './actions/ollamaCodeModelConfigBridge.js'; // OLLAMACODE_BIDIR_CTX`
        );
        fs.writeFileSync(contrib, s);
        console.log("✓ chat.contribution bridge import");
      }
    } else {
      console.log("· chat.contribution bridge import ok");
    }
  }

  const mpc = path.join(
    oss,
    "src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerModelConfig.ts"
  );
  if (fs.existsSync(mpc)) {
    const s = fs.readFileSync(mpc, "utf8");
    console.log((s.includes("OLLAMACODE_BIDIR_CTX") ? "·" : "⚠") + " modelPickerModelConfig bidir hook");
  }
  const cip = path.join(oss, "src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts");
  if (fs.existsSync(cip)) {
    const s = fs.readFileSync(cip, "utf8");
    console.log((s.includes("OLLAMACODE_BIDIR_CTX") ? "·" : "⚠") + " chatInputPart.applyModelConfiguration");
  }
}

// 13) Model picker: Context chip + Thinking (brain) + gear → ModelSettingsPanel
{
  const cfg = path.join(oss, "src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerConfiguration.ts");
  if (fs.existsSync(cfg)) {
    const s = fs.readFileSync(cfg, "utf8");
    const splitOk =
      s.includes("OLLAMACODE_HIDE_INPUT_CONFIG") ||
      s.includes("renderThinkingButton") ||
      s.includes("ollamaCode.editModelSettings");
    console.log((splitOk ? "·" : "⚠") + " picker context/thinking/gear hooks");
  }
  const widget = path.join(oss, "src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerWidget.ts");
  if (fs.existsSync(widget)) {
    const s = fs.readFileSync(widget, "utf8");
    console.log((s.includes("OLLAMACODE_SPLIT_CONTROLS") ? "·" : "⚠") + " split controls (context|brain|gear)");
  }
  const prim = path.join(oss, "src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerItemPrimitives.ts");
  if (fs.existsSync(prim)) {
    const s = fs.readFileSync(prim, "utf8");
    console.log((s.includes("OLLAMACODE_MODEL_ROW_GEAR") ? "·" : "⚠") + " model-row-gear");
  }
  const sec = path.join(oss, "src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerItemSections.ts");
  if (fs.existsSync(sec)) {
    const s = fs.readFileSync(sec, "utf8");
    console.log((s.includes("OLLAMACODE_NO_OTHER_MODELS_GEAR") ? "·" : "⚠") + " no-other-models-gear");
    console.log((s.includes("OLLAMACODE_INSTALL_OLLAMA_CTA") ? "·" : "⚠") + " install-ollama CTA in picker sections");
  }
  const pres = path.join(oss, "src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerPresentation.ts");
  if (fs.existsSync(pres)) {
    const s = fs.readFileSync(pres, "utf8");
    console.log((s.includes("OLLAMACODE_NO_COPILOT_SETUP_PICKER") ? "·" : "⚠") + " no Copilot setup gate in picker");
  }
  const dash = path.join(oss, "src/vs/workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.ts");
  if (fs.existsSync(dash)) {
    const s = fs.readFileSync(dash, "utf8");
    console.log((s.includes("OLLAMACODE_INSTALL_OLLAMA_CTA") ? "·" : "⚠") + " install-ollama CTA in status dashboard");
  }
}

// 15) No Copilot Sign In in status bar
{
  const files = [
    path.join(oss, "out/vs/workbench/contrib/chat/browser/chatStatus/chatStatusEntry.js"),
    path.join(oss, "src/vs/workbench/contrib/chat/browser/chatStatus/chatStatusEntry.ts"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const s = fs.readFileSync(file, "utf8");
    console.log((s.includes("OLLAMACODE_NO_STATUS_SIGNIN") ? "·" : "⚠") + " no-status-signin in " + path.relative(oss, file));
  }
}

// 16) Empty-editor watermark letterpress → OllamaCode logo
{
  const brandDir = path.join(root, "ide", "letterpress");
  const names = [
    "letterpress-light.svg",
    "letterpress-dark.svg",
    "letterpress-hcLight.svg",
    "letterpress-hcDark.svg",
  ];
  const targets = [
    path.join(oss, "src/vs/workbench/browser/parts/editor/media"),
    path.join(oss, "out/vs/workbench/browser/parts/editor/media"),
  ];
  if (fs.existsSync(brandDir)) {
    let copied = 0;
    for (const name of names) {
      const srcFile = path.join(brandDir, name);
      if (!fs.existsSync(srcFile)) continue;
      const srcBuf = fs.readFileSync(srcFile);
      for (const dir of targets) {
        if (!fs.existsSync(dir)) continue;
        const dest = path.join(dir, name);
        let same = false;
        if (fs.existsSync(dest)) {
          try {
            same = Buffer.compare(srcBuf, fs.readFileSync(dest)) === 0;
          } catch {
            same = false;
          }
        }
        if (!same) {
          fs.writeFileSync(dest, srcBuf);
          copied++;
        }
      }
    }
    console.log(
      copied
        ? "✓ letterpress watermark → OllamaCode logo"
        : "· letterpress watermark already branded"
    );
  } else {
    console.log("· letterpress brand folder missing (ide/letterpress)");
  }
}

// 17) Title-bar / window-appicon → same brand PNG as desktop icon
{
  const brandPng =
    [
      path.join(root, "ide", "brand", "code-icon-1024.png"),
      path.join(root, "ollamacode-icon.png"),
      path.join(root, "extensions", "ollama-agent", "media", "icon.png"),
    ].find((p) => fs.existsSync(p)) || null;
  const brandSvg = path.join(root, "ide", "brand", "code-icon.svg");
  const mediaTargets = [
    path.join(oss, "src/vs/workbench/browser/media"),
    path.join(oss, "out/vs/workbench/browser/media"),
  ];
  if (brandPng) {
    let copied = 0;
    const pngBuf = fs.readFileSync(brandPng);
    const svgBuf = fs.existsSync(brandSvg) ? fs.readFileSync(brandSvg) : null;
    for (const dir of mediaTargets) {
      fs.mkdirSync(dir, { recursive: true });
      const destPng = path.join(dir, "code-icon.png");
      let samePng = false;
      if (fs.existsSync(destPng)) {
        try {
          samePng = Buffer.compare(pngBuf, fs.readFileSync(destPng)) === 0;
        } catch {
          samePng = false;
        }
      }
      if (!samePng) {
        fs.writeFileSync(destPng, pngBuf);
        copied++;
      }
      if (svgBuf) {
        const destSvg = path.join(dir, "code-icon.svg");
        let sameSvg = false;
        if (fs.existsSync(destSvg)) {
          try {
            sameSvg = Buffer.compare(svgBuf, fs.readFileSync(destSvg)) === 0;
          } catch {
            sameSvg = false;
          }
        }
        if (!sameSvg) {
          fs.writeFileSync(destSvg, svgBuf);
          copied++;
        }
      }
    }
    console.log(
      copied
        ? "✓ titlebar code-icon.png → OllamaCode brand"
        : "· titlebar code-icon already branded"
    );
  } else {
    console.log("· brand PNG missing for titlebar");
  }

  // Point titlebar CSS at the PNG (pixel-identical to desktop icon)
  for (const css of [
    path.join(oss, "src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css"),
    path.join(oss, "out/vs/workbench/browser/parts/titlebar/media/titlebarpart.css"),
  ]) {
    if (!fs.existsSync(css)) continue;
    let s = fs.readFileSync(css, "utf8");
    if (s.includes("OLLAMACODE_TITLEBAR_ICON")) {
      console.log("· titlebar PNG already patched");
      continue;
    }
    const from =
      ".monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left > .window-appicon:not(.codicon) {\n\tbackground-image: url('../../../media/code-icon.svg');\n\tbackground-repeat: no-repeat;\n\tbackground-position: center center;\n\tbackground-size: 16px;\n}";
    const to =
      ".monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left > .window-appicon:not(.codicon) {\n\t/* OLLAMACODE_TITLEBAR_ICON — use brand PNG so titlebar matches desktop app icon */\n\tbackground-image: url('../../../media/code-icon.png');\n\tbackground-repeat: no-repeat;\n\tbackground-position: center center;\n\tbackground-size: 20px;\n}";
    if (s.includes(from)) {
      fs.writeFileSync(css, s.replace(from, to));
      console.log("✓ titlebar CSS → code-icon.png");
    } else if (s.includes("code-icon.svg") && s.includes("window-appicon:not(.codicon)")) {
      s = s.replace(
        /background-image:\s*url\('\.\.\/\.\.\/\.\.\/media\/code-icon\.svg'\);/,
        "/* OLLAMACODE_TITLEBAR_ICON */\n\tbackground-image: url('../../../media/code-icon.png');"
      );
      s = s.replace(
        /(window-appicon:not\(\.codicon\) \{[\s\S]*?background-size:\s*)16px/,
        "$120px"
      );
      fs.writeFileSync(css, s);
      console.log("✓ titlebar CSS → code-icon.png (fuzzy)");
    } else {
      console.log("⚠ titlebar CSS pattern not found: " + path.relative(oss, css));
    }
  }
}

// 18) Ollama llama provider icon (before BYOK → sparkle)
{
  const icons = path.join(
    oss,
    "src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelProviderIcons.ts"
  );
  if (fs.existsSync(icons)) {
    let s = fs.readFileSync(icons, "utf8");
    if (!s.includes("OLLAMACODE_LLAMA_ICON")) {
      if (s.includes("chat-model-provider-generic") && s.includes("isBYOK")) {
        s = s.replace(
          `const genericModelProviderIcon = registerIcon('chat-model-provider-generic', Codicon.sparkle, localize('chatModelProviderGenericIcon', "Icon for other model providers."));`,
          `// OLLAMACODE_LLAMA_ICON — sparkle glyph is overridden via CSS mask (llama mark)
const ollamaModelProviderIcon = registerIcon('chat-model-provider-ollama', Codicon.sparkle, localize('chatModelProviderOllamaIcon', "Icon for Ollama / OllamaCode models."));
const ollamaModelProviderCompactIcon = registerIcon('chat-model-provider-ollama-compact', Codicon.sparkleCompact, localize('chatModelProviderOllamaCompactIcon', "Compact icon for Ollama / OllamaCode models."));
const genericModelProviderIcon = registerIcon('chat-model-provider-generic', Codicon.sparkle, localize('chatModelProviderGenericIcon', "Icon for other model providers."));`
        );
        // Soft note if already hand-patched in tree
        if (!s.includes("OLLAMACODE_LLAMA_ICON")) {
          console.log("· modelProviderIcons: add OLLAMACODE_LLAMA_ICON manually if tree already diverged");
        } else {
          fs.writeFileSync(icons, s);
          console.log("✓ modelProviderIcons → ollama llama icon");
        }
      }
    } else {
      console.log("· modelProviderIcons already has OLLAMACODE_LLAMA_ICON");
    }
  }
}

// 19) Strip Electron default_app "." so it is not opened as a second folder (vscode-140)
{
  const argvHelper = path.join(
    oss,
    "src/vs/platform/environment/node/argvHelper.ts"
  );
  if (fs.existsSync(argvHelper)) {
    let s = fs.readFileSync(argvHelper, "utf8");
    if (!s.includes("OLLAMACODE_STRIP_APP_PATH")) {
      const from =
        "\t// If dev, remove the first non-option argument: it's the app location\n" +
        "\tif (process.env['VSCODE_DEV']) {\n" +
        "\t\targs = stripAppPath(args) || [];\n" +
        "\t}";
      const to =
        "\t// If dev, remove the first non-option argument: it's the app location\n" +
        "\t// OLLAMACODE_STRIP_APP_PATH: Electron default_app always passes \".\" (OSS root).\n" +
        "\t// Without stripping, Code opens that folder as a second window (e.g. vscode-140).\n" +
        "\tconst defaultApp = Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp);\n" +
        "\tif (process.env['VSCODE_DEV'] || defaultApp || args[0] === '.') {\n" +
        "\t\targs = stripAppPath(args) || [];\n" +
        "\t}";
      if (s.includes(from)) {
        fs.writeFileSync(argvHelper, s.replace(from, to));
        console.log("✓ argvHelper.ts strip default_app path");
      } else if (s.includes("OLLAMACODE_STRIP_APP_PATH")) {
        console.log("· argvHelper already stripped");
      } else {
        console.log("⚠ argvHelper strip pattern not found");
      }
    } else {
      console.log("· argvHelper already has OLLAMACODE_STRIP_APP_PATH");
    }
  }

  // Keep out-fast main process in sync (fat bundle) without a full rebuild
  const mainImpl = path.join(oss, "out-fast/mainImpl.js");
  if (fs.existsSync(mainImpl)) {
    let s = fs.readFileSync(mainImpl, "utf8");
    if (!s.includes("OLLAMACODE_STRIP_APP_PATH")) {
      const from =
        '  if (process.env["VSCODE_DEV"]) {\n    args2 = stripAppPath(args2) || [];\n  }';
      const to =
        '  // OLLAMACODE_STRIP_APP_PATH — default_app passes "."; without strip Code opens vscode-140 as a folder\n' +
        '  if (process.env["VSCODE_DEV"] || process["defaultApp"] || args2[0] === ".") {\n' +
        "    args2 = stripAppPath(args2) || [];\n" +
        "  }";
      if (s.includes(from)) {
        fs.writeFileSync(mainImpl, s.replace(from, to));
        console.log("✓ out-fast/mainImpl.js strip default_app path");
      } else {
        console.log("⚠ out-fast/mainImpl.js strip pattern not found");
      }
    } else {
      console.log("· out-fast/mainImpl.js already stripped");
    }
  }
}

// ---------------------------------------------------------------------------
// OLLAMACODE_LIVE_FOLDER — single-folder replace without EH restart / openFolder
// ---------------------------------------------------------------------------
patchFile(
  "src/vs/workbench/services/workspaces/browser/abstractWorkspaceEditingService.ts",
  "OLLAMACODE_LIVE_FOLDER",
  (src) => {
    if (src.includes("OLLAMACODE_LIVE_FOLDER")) return src;
    let out = src;
    const nl = out.includes("\r\n") ? "\r\n" : "\n";
    if (!out.includes("ISingleFolderWorkspaceIdentifier")) {
      out = out.replace(
        "IWorkspaceIdentifier, toWorkspaceIdentifier,",
        "IWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, toWorkspaceIdentifier,"
      );
    }
    const oldBranch = [
      "if (this.includesSingleFolderWorkspace(foldersToDelete)) {",
      "\t\t\t\treturn this.createAndEnterWorkspace(foldersToAdd);",
      "\t\t\t}",
    ].join(nl);
    const newBranch = [
      "if (this.includesSingleFolderWorkspace(foldersToDelete)) {",
      "\t\t\t\t// OLLAMACODE_LIVE_FOLDER — replace 1→1 without createAndEnterWorkspace / EH kill",
      "\t\t\t\tif (foldersToAdd.length === 1) {",
      "\t\t\t\t\treturn this.liveReplaceSingleFolderWorkspace(foldersToAdd[0]);",
      "\t\t\t\t}",
      "\t\t\t\treturn this.createAndEnterWorkspace(foldersToAdd);",
      "\t\t\t}",
    ].join(nl);
    if (!out.includes(oldBranch)) {
      console.warn("⚠ live-folder source branch pattern mismatch");
      return src;
    }
    out = out.replace(oldBranch, newBranch);
    const method = [
      "",
      "\t/** OLLAMACODE_LIVE_FOLDER: swap the only root in-place; keep EH + chat alive. */",
      "\tprivate async liveReplaceSingleFolderWorkspace(folder: IWorkspaceFolderCreationData): Promise<void> {",
      "\t\tconst uri = removeTrailingPathSeparator(folder.uri);",
      "\t\tconst oldWorkspace = toWorkspaceIdentifier(this.contextService.getWorkspace());",
      "\t\tconst identifier: ISingleFolderWorkspaceIdentifier = {",
      "\t\t\tid: this.contextService.getWorkspace().id,",
      "\t\t\turi,",
      "\t\t};",
      "\t\tthis.logService.info(`[OLLAMACODE_LIVE_FOLDER] ${uri.toString()}`);",
      "\t\tawait this.contextService.initialize(identifier);",
      "\t\tawait this.fireDidEnterWorkspace(oldWorkspace, identifier);",
      "\t}",
      "",
    ].join(nl);
    const anchor = "\tprivate includesSingleFolderWorkspace(folders: URI[]): boolean {";
    if (!out.includes(anchor)) {
      console.warn("⚠ live-folder method anchor mismatch");
      return src;
    }
    out = out.replace(anchor, method + anchor);
    return out;
  }
);

{
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "_patch-live-folder.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (r.status) console.warn("⚠ live-folder bundle patch exited", r.status);
}
{
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "_patch-chat-filetree.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (r.status) console.warn("⚠ chat-filetree bundle patch exited", r.status);
}
