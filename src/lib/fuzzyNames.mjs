import { normalizeText, tokenizeName } from "./text.mjs";

export function bestFuzzyRosterMatch(text, racer) {
  const observed = transcriptNameCandidates(text);
  const racerTokens = tokenizeName(racer.name);
  const racerLast = racerTokens.at(-1) || "";
  const racerFirst = racerTokens[0] || "";
  let best = null;

  for (const candidate of observed) {
    const candidateNorm = normalizeText(candidate);
    const score = Math.max(
      nameSimilarity(candidateNorm, normalizeText(racer.name)),
      racerLast ? nameSimilarity(candidateNorm, racerLast) : 0,
      racerFirst ? nameSimilarity(candidateNorm, racerFirst) : 0,
      soundex(candidateNorm) && soundex(candidateNorm) === soundex(racerLast) ? 0.82 : 0,
      soundex(candidateNorm) && soundex(candidateNorm) === soundex(racerFirst) ? 0.78 : 0
    );
    if (!best || score > best.score) best = { observed: candidate, score };
  }

  return best;
}

export function transcriptNameCandidates(text) {
  const capitalized = String(text || "").match(/\b[A-Z][a-zA-Z'-]{2,}(?:\s+[A-Z][a-zA-Z'-]{2,})?\b/g) || [];
  return [...new Set(capitalized)].slice(0, 30);
}

export function nameSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export function soundex(value) {
  const text = normalizeText(value).replace(/[^a-z]/g, "").toUpperCase();
  if (!text) return "";
  const first = text[0];
  const codes = {
    B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3",
    L: "4",
    M: "5", N: "5",
    R: "6"
  };
  let out = first;
  let prev = codes[first] || "";
  for (const char of text.slice(1)) {
    const code = codes[char] || "";
    if (code && code !== prev) out += code;
    prev = code;
  }
  return `${out}000`.slice(0, 4);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}
