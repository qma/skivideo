import crypto from "node:crypto";

export function stableId(prefix, value) {
  const hash = crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function slugify(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "unknown";
}
