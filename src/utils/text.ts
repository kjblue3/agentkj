const stopWords = new Set([
  "a", "an", "and", "are", "did", "do", "for", "from", "how", "in", "is",
  "it", "of", "on", "or", "our", "the", "this", "to", "was", "we", "what",
  "when", "why", "with", "still"
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
