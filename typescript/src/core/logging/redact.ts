const KEY = /(AIza[0-9A-Za-z\-_]{16,}|ya29\.[0-9A-Za-z\-_]+)/g;
export function sanitizeMessage(message: string, secrets: string[] = [], maxLength = 2000): string {
  let s = message.replace(KEY, '[REDACTED_KEY]');
  for (const secret of secrets.filter((x) => x.length >= 4)) s = s.split(secret).join('[REDACTED]');
  return s.length > maxLength ? `${s.slice(0, maxLength)}...[truncated]` : s;
}
export function safeJson(value: unknown, secrets: string[] = []): string {
  return sanitizeMessage(JSON.stringify(value), secrets);
}
