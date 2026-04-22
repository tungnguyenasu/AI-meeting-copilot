// Trigram Jaccard similarity. Cheap, offline, zero-dep. Good enough to
// catch near-duplicate suggestion titles/previews that slip through the
// "don't repeat these titles" prompt hint (e.g. "ask about pricing"
// vs "probe on cost"). Tuned against the suggestion-generation output
// shape; raise DUPLICATE_THRESHOLD for looser dedup, lower to catch
// more paraphrases at the cost of some false positives.

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function trigrams(s: string): Set<string> {
  const n = normalize(s);
  if (n.length < 3) return new Set(n ? [n] : []);
  const out = new Set<string>();
  for (let i = 0; i <= n.length - 3; i++) out.add(n.slice(i, i + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarityScore(
  a: { title: string; preview: string },
  b: { title: string; preview: string },
): number {
  const at = trigrams(`${a.title} ${a.preview}`);
  const bt = trigrams(`${b.title} ${b.preview}`);
  return jaccard(at, bt);
}

export const DUPLICATE_THRESHOLD = 0.55;
