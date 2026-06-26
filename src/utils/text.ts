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

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "." && character !== "!" && character !== "?") continue;

    const previous = text[index - 1];
    const next = text[index + 1];
    const isDecimalOrVersionDot =
      character === "." && /\d/.test(previous ?? "") && /\d/.test(next ?? "");
    if (isDecimalOrVersionDot) continue;

    const endsSentence = next === undefined || /\s/.test(next);
    if (!endsSentence) continue;

    const sentence = text.slice(start, index + 1).trim();
    if (sentence) sentences.push(sentence);
    start = index + 1;
  }

  const remainder = text.slice(start).trim();
  if (remainder) sentences.push(remainder);
  return sentences;
}
