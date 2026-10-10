/**
 * Guard rails for windows_desktop — prevent the agent from wrecking the user's
 * messenger/browser/IDE (e.g. Alt+F4 / close on Telegram that then won't relaunch).
 */

/** Process names (case-insensitive, no .exe) the agent must never close or Alt+F4. */
export const PROTECTED_DESKTOP_PROCESSES = [
  // Messengers — E2E may click/type inside, never close
  "telegram",
  "telegramdesktop",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "element",
  "skype",
  "teams",
  "ms-teams",
  "zoom",
  // Browsers (accidental close loses work)
  "chrome",
  "msedge",
  "firefox",
  "opera",
  "brave",
  "vivaldi",
  // This IDE / Electron hosts
  "ollamacode",
  "code",
  "code - oss",
  "electron",
  "cursor",
  // Shell / system — catastrophic if closed via WM_CLOSE incorrectly
  "explorer",
  "dwm",
  "csrss",
  "winlogon",
  "taskmgr",
  "systemsettings",
  "searchhost",
  "shellexperiencehost",
  "startmenuexperiencehost",
  "applicationframehost",
];

const PROTECTED_TITLE_HINTS =
  /\b(telegram|discord|slack|whatsapp|signal|microsoft teams|ollamacode)\b/i;

/** Alt+F4 / similar that quit the focused app. */
export function isQuitKeyChord(keys: string): boolean {
  const k = String(keys || "").trim();
  if (!k) return false;
  // SendKeys: %{F4} = Alt+F4; !{F4} = Alt+F4 in some docs; %F4 without braces
  if (/%\{?\s*F4\s*\}?/i.test(k)) return true;
  if (/!\{?\s*F4\s*\}?/i.test(k)) return true;
  // Alt+Space then C (system menu Close)
  if (/%\s*\{?\s*SPACE\s*\}?.*[cс]/i.test(k) && /close|закры/i.test(k) === false) {
    // %{ }c pattern
    if (/%\{?\s* \s*\}?[cс]/i.test(k) || /%\s+c/i.test(k)) return true;
  }
  if (/%\s*\{?\s*F4/i.test(k)) return true;
  return false;
}

export function isProtectedProcessName(process: string | undefined | null): boolean {
  const p = String(process || "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, "");
  if (!p) return false;
  return PROTECTED_DESKTOP_PROCESSES.some((x) => p === x || p.includes(x) || x.includes(p));
}

export function isProtectedWindowHint(title?: string | null, process?: string | null): boolean {
  if (isProtectedProcessName(process)) return true;
  const t = String(title || "").trim();
  if (t && PROTECTED_TITLE_HINTS.test(t)) return true;
  return false;
}

export type DesktopSafetyInput = {
  action?: string;
  title?: string;
  process?: string;
  keys?: string;
  hwnd?: number;
  target?: string;
};

/**
 * Pre-flight check before spawning windows-ui.ps1.
 * Returns an error message to surface as FAILED, or null if allowed.
 */
export function checkDesktopActionSafety(input: DesktopSafetyInput): string | null {
  const action = String(input.action || "")
    .trim()
    .toLowerCase();
  if (!action) return "action required";

  const title = String(input.title || "");
  const process = String(input.process || "");
  const keys = String(input.keys || "");

  if (action === "close") {
    if (isProtectedWindowHint(title, process)) {
      return (
        `REFUSED: close blocked for protected app` +
        `${process ? ` process=${process}` : ""}${title ? ` title=${title.slice(0, 60)}` : ""}. ` +
        `Messengers/browsers/IDE must stay open. For bot E2E: focus chat → type → never close Telegram.`
      );
    }
    // closing without any target often hits the wrong foreground window
    if (!input.hwnd && !title.trim() && !process.trim()) {
      return "REFUSED: close requires hwnd (preferred) or title/process — refusing unscoped close";
    }
  }

  if (action === "keys") {
    if (!input.hwnd && !title.trim() && !process.trim()) {
      return "REFUSED: keys requires hwnd|title|process — refusing global SendKeys (can hit Telegram/IDE)";
    }
    if (isQuitKeyChord(keys)) {
      if (isProtectedWindowHint(title, process)) {
        return (
          `REFUSED: Alt+F4/quit keys blocked on protected app` +
          `${process ? ` process=${process}` : ""}. Never close Telegram/Discord/browsers/IDE.`
        );
      }
      // Even without explicit process — quit chords are too dangerous for agents
      return (
        "REFUSED: Alt+F4 / quit key chord blocked. Do not close apps via keys — " +
        "leave messengers open; only interact (type/click) inside the chat under test."
      );
    }
  }

  if (action === "launch") {
    const target = String(input.target || "").toLowerCase();
    // Don't relaunch Telegram via weird kill-restart loops; user can open it
    if (/taskkill|stop-process|kill\s/i.test(target)) {
      return "REFUSED: launch target looks like a kill command";
    }
  }

  return null;
}
