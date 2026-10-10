/**
 * Detect placeholder / example secrets so TOOL_RESULT tells the model
 * to warn the user — not claim the app is fully configured.
 */

const PLACEHOLDER_PATTERNS: RegExp[] = [
  // Official Telegram Bot API docs example token
  /\b123456:ABC-DEF123456789\b/i,
  /\bYOUR[_-]?[A-Z0-9]*[_-]?(TOKEN|KEY|SECRET|PASSWORD)\b/i,
  /\b(?:CHANGE_ME|REPLACE_ME|INSERT_HERE|TODO_TOKEN|xxx+|<.*>)\b/i,
  /\b(?:sk|pk|ghp|github_pat)-?(?:test|fake|dummy|example|xxx)\b/i,
  /(?:BOT_TOKEN|API_KEY|SECRET|PASSWORD|TOKEN)\s*=\s*["']?(?:test|fake|dummy|example|placeholder|xxx+)["']?/i,
];

const SECRET_FILE = /(^|[\\/])(\.env|\.env\.\w+|credentials\.(json|ya?ml)|secrets\.(json|ya?ml))$/i;
const SECRET_KEY_LINE =
  /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIALS?)[A-Z0-9_]*)\s*=\s*(.+)$/im;

export function looksLikePlaceholderSecret(text: string): boolean {
  const s = String(text || "");
  if (!s.trim()) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(s));
}

/** Hint for model + user when a write touched secrets / placeholders. */
export function secretWriteHint(path: string, content: string): string | undefined {
  const p = path.replace(/\//g, "\\");
  const isSecretFile = SECRET_FILE.test(p);
  const hasSecretKey = SECRET_KEY_LINE.test(content);
  if (!isSecretFile && !hasSecretKey && !looksLikePlaceholderSecret(content)) {
    return undefined;
  }

  const lines: string[] = [];
  if (looksLikePlaceholderSecret(content) || (isSecretFile && looksLikePlaceholderSecret(content))) {
    lines.push(
      "SECRET_PLACEHOLDER: в файле заглушка/пример секрета, не настоящий ключ пользователя.",
      "В финальном ответе ОБЯЗАТЕЛЬНО скажи пользователю: подставь свой реальный токен (например BotFather → .env), иначе прод не заработает.",
      "Не утверждай, что бот уже настроен с рабочим токеном."
    );
  } else if (isSecretFile || hasSecretKey) {
    lines.push(
      "SECRET_FILE: записан секретный конфиг. В итоговом ответе кратко напомни, что значение должно быть реальным токеном пользователя, не выдуманным."
    );
  }

  if (/token\s*\(\s*["'][^"']+["']\s*\)/i.test(content) && looksLikePlaceholderSecret(content)) {
    lines.push(
      "Не хардкодь токен в коде — читай из os.environ / .env (python-dotenv)."
    );
  }

  return lines.length ? lines.join(" ") : undefined;
}
