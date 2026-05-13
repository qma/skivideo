import { createHash } from "node:crypto";

export function buildTranscriptionPrompt(config, folder, options = {}) {
  const maxNames = Number(options.maxNames || config.transcriptionPromptMaxNames || 80);
  const event = folder?.eventMatch || {};
  const roster = prioritizeRoster(folder?.candidateRoster || []);
  const names = roster.slice(0, Math.max(0, maxNames)).map((racer) => racer.name).filter(Boolean);
  const prompt = [
    "This is U14 ski race video audio.",
    "Use ski racing wording such as run one, run two, first run, second run, bib number, start, finish, course.",
    "Club and venue terms include Team Palisades Tahoe, TPT, TPTA, Palisades Tahoe, and Northstar.",
    event.date || event.venue || event.discipline
      ? `Event context: ${[event.date, event.venue, event.discipline].filter(Boolean).join(", ")}.`
      : "",
    names.length ? `Likely athlete names: ${names.join(", ")}.` : ""
  ].filter(Boolean).join(" ");
  return {
    prompt,
    hash: promptHash(prompt),
    nameCount: names.length,
    phraseVersion: "ski-race-v1"
  };
}

export function shouldUseTranscriptionPrompt(config, options = {}) {
  if (options.transcriptionPrompt === true) return true;
  if (options.transcriptionPrompt === false) return false;
  return Boolean(config.transcriptionPromptEnabled);
}

function prioritizeRoster(roster) {
  return [...roster].sort((a, b) => {
    const aTeam = /^(TPT|TPTA)$/i.test(a.team || "") ? 0 : 1;
    const bTeam = /^(TPT|TPTA)$/i.test(b.team || "") ? 0 : 1;
    return aTeam - bTeam || String(a.name).localeCompare(String(b.name));
  });
}

function promptHash(prompt) {
  return createHash("sha1").update(prompt).digest("hex").slice(0, 10);
}
