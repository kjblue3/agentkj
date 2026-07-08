const SECRET_KEY_PATTERN = /(token|secret|password|authorization|credential|api.?key|cookie)/i;

export function redactSecrets(value: unknown, secrets: Array<string | undefined> = [], depth = 0): unknown {
  const redactionValues = secrets.map((secret) => secret?.trim()).filter((secret): secret is string => Boolean(secret));
  if (depth > 8) return "[truncated]";

  if (typeof value === "string") return redactText(value, redactionValues);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSecrets(item, redactionValues, depth + 1));
  if (!value || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    sanitized[key] = SECRET_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactSecrets(child, redactionValues, depth + 1);
  }
  return sanitized;
}

export function redactText(value: string, secrets: Array<string | undefined> = []): string {
  let text = value;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (trimmed) text = text.split(trimmed).join("[REDACTED]");
  }
  return text;
}
