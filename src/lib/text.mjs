export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeName(name) {
  return normalizeText(name).split(" ").filter(Boolean);
}

export function includesName(text, name) {
  const haystack = ` ${normalizeText(text)} `;
  const tokens = tokenizeName(name);
  if (tokens.length === 0) return false;
  if (haystack.includes(` ${tokens.join(" ")} `)) return true;
  return tokens.length >= 2 && tokens.every((token) => haystack.includes(` ${token} `));
}

export function scoreFolderEventMatch(folderName, event) {
  const folder = normalizeText(folderName);
  const eventText = normalizeText([
    event.name,
    event.title,
    event.venue,
    event.date,
    event.discipline
  ].filter(Boolean).join(" "));
  const eventTokens = new Set(eventText.split(" ").filter((token) => token.length > 2));
  const folderTokens = new Set(folder.split(" ").filter((token) => token.length > 2));
  let overlap = 0;
  for (const token of eventTokens) {
    if (folderTokens.has(token)) overlap += 1;
  }
  const dateBoost = event.date && folder.includes(normalizeText(event.date)) ? 0.35 : 0;
  const ratio = eventTokens.size ? overlap / eventTokens.size : 0;
  return Math.min(1, ratio * 0.65 + dateBoost);
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
