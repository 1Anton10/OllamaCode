# Apply OllamaCode patches onto .cache/vscode (Code-OSS)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$oss = Join-Path $root ".cache\vscode"
if (-not (Test-Path $oss)) {
  throw "Сначала: scripts\bootstrap-oss.ps1"
}

Write-Host "== OllamaCode: apply OSS patches =="

# --- 1) product.json branding ---
$overlayPath = Join-Path $root "ide\product.json"
$productPath = Join-Path $oss "product.json"
$base = Get-Content $productPath -Raw | ConvertFrom-Json
$over = Get-Content $overlayPath -Raw | ConvertFrom-Json

$keys = @(
  "nameShort","nameLong","applicationName","dataFolderName","urlProtocol",
  "win32MutexName","win32DirName","win32NameVersion","win32RegValueName",
  "win32AppUserModelId","win32ShellNameShort","win32AppId","win32x64AppId",
  "win32arm64AppId","win32x64UserAppId","win32arm64UserAppId",
  "win32TunnelServiceMutex","win32TunnelMutex",
  "serverApplicationName","serverDataFolderName","tunnelApplicationName",
  "darwinBundleIdentifier","linuxIconName","enableTelemetry","aiConfig",
  "defaultChatAgent","extensionsGallery","extensionEnabledApiProposals",
  "linkProtectionTrustedDomains","reportIssueUrl","licenseName","licenseUrl"
)
foreach ($p in $keys) {
  if ($over.PSObject.Properties.Name -contains $p) {
    $base | Add-Member -NotePropertyName $p -NotePropertyValue $over.$p -Force
  }
}
# Keep OSS builtInExtensions (js-debug) — do not wipe
$base | ConvertTo-Json -Depth 100 | Set-Content $productPath -Encoding utf8
Write-Host "  product.json branded as OllamaCode"

# --- 2) junction built-in extension ---
$dest = Join-Path $oss "extensions\ollama-agent"
$src = Join-Path $root "extensions\ollama-agent"
if (Test-Path $dest) {
  cmd /c rmdir "$dest" 2>$null
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
}
cmd /c mklink /J "$dest" "$src" | Out-Null
Write-Host "  linked extensions/ollama-agent"

# --- 3) patch Accounts menu: drop Sync / Tunnel / cloud auth menu noise ---
$accountsFile = Join-Path $oss "src\vs\workbench\browser\parts\globalCompositeBar.ts"
$af = Get-Content $accountsFile -Raw
if ($af -notmatch "OLLAMACODE_ACCOUNTS_FILTER") {
  $needle = @"
		otherCommands.forEach((group, i) => {
			const actions = group[1];
			menus = menus.concat(actions);
			if (i !== otherCommands.length - 1) {
				menus.push(new Separator());
			}
		});
"@
  $repl = @"
		// OLLAMACODE_ACCOUNTS_FILTER — local profiles only; hide Sync/Tunnel/cloud sign-in clutter
		otherCommands.forEach((group, i) => {
			const actions = group[1].filter(a => {
				const id = (a.id || '').toLowerCase();
				const label = (a.label || '').toLowerCase();
				if (/sync|tunnel|copilot|chatgpt|openai|backup and sync|cloud changes|remote tunnel/.test(id + ' ' + label)) {
					return false;
				}
				return true;
			});
			if (!actions.length) {
				return;
			}
			menus = menus.concat(actions);
			if (i !== otherCommands.length - 1) {
				menus.push(new Separator());
			}
		});
"@
  if ($af.Contains($needle.Trim())) {
    $af = $af.Replace($needle, $repl)
    Set-Content $accountsFile $af -Encoding utf8NoBOM
    Write-Host "  patched Accounts menu filter"
  } else {
    Write-Host "  WARN: Accounts patch anchor not found (VS Code source drift)"
  }
} else {
  Write-Host "  Accounts filter already applied"
}

# --- 4) patch Model picker: native HF browse entry ---
$pickerFile = Join-Path $oss "src\vs\workbench\contrib\chat\browser\chatInputPart.ts"
$pf = Get-Content $pickerFile -Raw
if ($pf -notmatch "OLLAMACODE_HF_PICKER") {
  $needle2 = @"
				actions.push(...menuContributions);
				if (chatEntitlementService.entitlement === ChatEntitlement.Limited) {
					actions.push(toAction({
						id: 'moreModels', label: localize('chat.moreModels', "Add more Models"), run: () => {
							const commandId = 'workbench.action.chat.upgradePlan';
							telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: commandId, from: 'chat-models' });
							commandService.executeCommand(commandId);
						}
					}));
				}
				return actions;
"@
  $repl2 = @"
				actions.push(...menuContributions);
				// OLLAMACODE_HF_PICKER — browse/download GGUF from Hugging Face into Ollama
				actions.push(new Separator());
				actions.push(toAction({
					id: 'ollamacode.browseHfModels',
					label: localize('ollamacode.browseHf', "Download from Hugging Face…"),
					run: () => {
						commandService.executeCommand('ollamaCode.pullHfModel').then(undefined, () => {
							commandService.executeCommand('ollamaCode.manageModels');
						});
					}
				}));
				actions.push(toAction({
					id: 'ollamacode.refreshModels',
					label: localize('ollamacode.refreshModels', "Refresh Ollama models"),
					run: () => commandService.executeCommand('ollamaCode.refreshModels')
				}));
				if (chatEntitlementService.entitlement === ChatEntitlement.Limited) {
					// skip Copilot upgrade plan in OllamaCode
				}
				return actions;
"@
  if ($pf.Contains($needle2.Trim()) -or $pf.Contains("actions.push(...menuContributions);")) {
    # try flexible replace
    if ($pf.Contains($needle2)) {
      $pf = $pf.Replace($needle2, $repl2)
    } else {
      $pf = $pf.Replace(
        "actions.push(...menuContributions);",
        @"
actions.push(...menuContributions);
				// OLLAMACODE_HF_PICKER
				actions.push(new Separator());
				actions.push(toAction({
					id: 'ollamacode.browseHfModels',
					label: localize('ollamacode.browseHf', `"Download from Hugging Face…`"),
					run: () => {
						commandService.executeCommand('ollamaCode.pullHfModel').then(undefined, () => {
							commandService.executeCommand('ollamaCode.manageModels');
						});
					}
				}));
				actions.push(toAction({
					id: 'ollamacode.refreshModels',
					label: localize('ollamacode.refreshModels', `"Refresh Ollama models`"),
					run: () => commandService.executeCommand('ollamaCode.refreshModels')
				}));
"@
      )
    }
    Set-Content $pickerFile $pf -Encoding utf8NoBOM
    Write-Host "  patched Model picker (HF + refresh)"
  } else {
    Write-Host "  WARN: Model picker patch anchor not found"
  }
} else {
  Write-Host "  HF picker already applied"
}

# --- 5) copy icon into OSS resources if present ---
$iconSrc = Join-Path $root "extensions\ollama-agent\media\icon.png"
$iconDirs = @(
  (Join-Path $oss "resources\win32"),
  (Join-Path $oss "resources\linux"),
  (Join-Path $oss "resources\darwin")
)
if (Test-Path $iconSrc) {
  foreach ($d in $iconDirs) {
    if (Test-Path $d) {
      Copy-Item $iconSrc (Join-Path $d "ollamacode.png") -Force
    }
  }
  Write-Host "  icon copied"
}

Write-Host @"

Patches applied.
Next:
  $($root)\scripts\oss-dev.ps1     # npm i + watch + Electron (hot reload)
  $($root)\scripts\oss-install.ps1 # full win32 package (slow)

"@
