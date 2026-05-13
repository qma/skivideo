import { includesName, normalizeText, tokenizeName } from "../lib/text.mjs";
import { bestFuzzyRosterMatch } from "../lib/fuzzyNames.mjs";

export async function labelVideoAthletes(config, video, folder) {
  const deterministic = deterministicLabels(video, folder);
  if (config.openaiApiKey && process.env.LLM_LABEL_MODE === "always") {
    return mergeLabels(deterministic, await labelWithOpenAi(config, video, folder));
  }
  if (deterministic.length || !config.openaiApiKey) return deterministic;
  return labelWithOpenAi(config, video, folder);
}

export function deterministicLabels(video, folder) {
  const transcriptText = video.transcript?.text || "";
  const filename = video.filename || "";
  const roster = folder?.candidateRoster || [];
  const labels = [];
  const fuzzyMatches = new Map();
  const fuzzyObservedCounts = new Map();
  const filenameMatches = new Map();

  for (const racer of roster) {
    const fuzzy = bestFuzzyRosterMatch(transcriptText, racer);
    fuzzyMatches.set(racer, fuzzy);
    filenameMatches.set(racer, bestFilenameRosterMatch(filename, racer, roster));
    if (fuzzy && fuzzy.score >= 0.76 && isSingleToken(fuzzy.observed)) {
      const key = normalizeText(fuzzy.observed);
      fuzzyObservedCounts.set(key, (fuzzyObservedCounts.get(key) || 0) + 1);
    }
  }

  for (const racer of roster) {
    const inTranscript = includesName(transcriptText, racer.name);
    const inFilename = includesName(filename.replace(/[_-]/g, " "), racer.name);
    const filenameRoster = filenameMatches.get(racer);
    const filenameRosterMatch = filenameRoster && filenameRoster.score >= 0.8;
    const bibMatch = racer.bib && filenameBibMatches(filename, racer.bib);
    const fuzzy = fuzzyMatches.get(racer);
    const fuzzyMatch = fuzzy && fuzzy.score >= 0.76;
    const ambiguousFuzzy = fuzzyMatch && isSingleToken(fuzzy.observed) && (fuzzyObservedCounts.get(normalizeText(fuzzy.observed)) || 0) > 1;
    if (!(inTranscript || inFilename || filenameRosterMatch || bibMatch || fuzzyMatch)) continue;
    const confidence = inTranscript ? 0.86 : inFilename ? 0.7 : filenameRosterMatch ? filenameRoster.confidence : bibMatch ? 0.58 : ambiguousFuzzy ? 0.52 : Math.min(0.68, fuzzy.score * 0.78);
    labels.push({
      name: racer.name,
      confidence,
      source: inTranscript ? "audio_transcript" : inFilename ? "filename_context" : filenameRosterMatch ? "filename_roster_match" : bibMatch ? "bib_filename_context" : ambiguousFuzzy ? "fuzzy_audio_roster_ambiguous" : "fuzzy_audio_roster_match",
      evidence: inTranscript
        ? evidenceSnippet(transcriptText, racer.name)
        : filenameRosterMatch
          ? `Filename token "${filenameRoster.observed}" matched roster name ${racer.name}`
        : fuzzyMatch
          ? ambiguousFuzzy
            ? `Transcript heard "${fuzzy.observed}", which matches multiple roster names including ${racer.name}`
            : `Transcript heard "${fuzzy.observed}", fuzzy-matched to roster name ${racer.name}`
          : `Matched ${inFilename ? "name" : "bib"} in filename ${filename}`,
      matchedRoster: true,
      fuzzy: fuzzyMatch ? { observed: fuzzy.observed, score: Number(fuzzy.score.toFixed(2)) } : undefined,
      methodVersion: "deterministic-v1"
    });
  }

  if (!labels.length) {
    const possible = inferCapitalizedNames(transcriptText);
    for (const name of possible) {
      labels.push({
        name,
        confidence: 0.42,
        source: "audio_transcript_unmatched_name",
        evidence: evidenceSnippet(transcriptText, name),
        matchedRoster: false,
        methodVersion: "deterministic-v1"
      });
    }
  }

  if (!labels.length) {
    for (const name of inferSingleWordCallouts(transcriptText)) {
      labels.push({
        name,
        confidence: 0.32,
        source: "audio_transcript_single_word",
        evidence: evidenceSnippet(transcriptText, name),
        matchedRoster: false,
        methodVersion: "deterministic-v1"
      });
    }
  }

  return dedupeLabels(labels).sort((a, b) => b.confidence - a.confidence);
}

async function labelWithOpenAi(config, video, folder) {
  const roster = (folder?.candidateRoster || []).map((racer) => `${racer.name}${racer.bib ? ` bib ${racer.bib}` : ""}${racer.club ? ` club ${racer.club}` : ""}`).join("\n");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.openaiLabelModel,
      input: [
        {
          role: "system",
          content: "Extract skier athlete names from a skiing video transcript. Use the roster as spelling/canonical-name context, especially Team Palisades Tahoe/TPT athletes. Allow fuzzy or phonetic matches, but lower confidence when the transcript is partial or ambiguous. Return compact JSON only."
        },
        {
          role: "user",
          content: JSON.stringify({
            filename: video.filename,
            transcript: video.transcript?.text || "",
            candidateRoster: roster
          })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "athlete_labels",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              labels: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    confidence: { type: "number" },
                    evidence: { type: "string" },
                    matchedRoster: { type: "boolean" }
                  },
                  required: ["name", "confidence", "evidence", "matchedRoster"]
                }
              }
            },
            required: ["labels"]
          }
        }
      }
    })
  });
  if (!response.ok) throw new Error(`OpenAI label request failed: ${response.status} ${await response.text()}`);
  const json = await response.json();
  const text = json.output_text || json.output?.flatMap((item) => item.content || []).map((c) => c.text).join("") || "{}";
  const parsed = JSON.parse(text);
  return (parsed.labels || []).map((label) => ({
    ...label,
    source: "llm_audio_roster_reasoning",
    methodVersion: "openai-json-v1"
  }));
}

function evidenceSnippet(text, name) {
  const normalized = normalizeText(text);
  const needle = normalizeText(name).split(" ")[0] || "";
  const idx = needle ? normalized.indexOf(needle) : -1;
  if (idx < 0) return String(text || "").slice(0, 180);
  return String(text || "").slice(Math.max(0, idx - 80), idx + 120).trim();
}

function inferCapitalizedNames(text) {
  const matches = String(text || "").match(/\b[A-Z][a-zA-Z'-]+\s+[A-Z][a-zA-Z'-]+\b/g) || [];
  return [...new Set(matches)].slice(0, 3);
}

function inferSingleWordCallouts(text) {
  const stop = new Set(["next", "run", "start", "finish", "course", "gate", "and", "the", "bib"]);
  const matches = String(text || "").match(/\b[A-Z][a-zA-Z'-]{2,}\b/g) || [];
  return [...new Set(matches.filter((word) => !stop.has(word.toLowerCase())))].slice(0, 3);
}

function dedupeLabels(labels) {
  const byName = new Map();
  for (const label of labels) {
    const key = normalizeText(label.name);
    if (!byName.has(key) || byName.get(key).confidence < label.confidence) {
      byName.set(key, label);
    }
  }
  return [...byName.values()];
}

function mergeLabels(...groups) {
  return dedupeLabels(groups.flat()).sort((a, b) => b.confidence - a.confidence);
}

function filenameBibMatches(filename, bib) {
  const target = String(bib || "").replace(/^0+/, "");
  if (!target) return false;
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  const candidates = [
    ...base.matchAll(/\b(?:bib|b)[ _.-]*0*(\d{1,3})\b/gi),
    ...base.matchAll(/(?:^|[^A-Za-z0-9])0*(\d{1,3})(?=$|[^A-Za-z0-9])/g)
  ].map((match) => match[1].replace(/^0+/, ""));
  return candidates.includes(target);
}

function bestFilenameRosterMatch(filename, racer, roster) {
  const filenameTokens = filenameNameTokens(filename);
  if (!filenameTokens.length) return null;
  const nameTokens = tokenizeName(racer.name);
  const first = nameTokens[0] || "";
  const last = nameTokens.at(-1) || "";
  const aliases = firstNameAliases(first);
  const firstOrAlias = [first, ...aliases].filter(Boolean);
  const hasFirst = firstOrAlias.some((token) => filenameTokens.includes(token));
  const hasLast = last && filenameTokens.includes(last);
  if (hasFirst && hasLast) {
    return { observed: `${first || aliases[0]} ${last}`.trim(), score: 0.94, confidence: 0.76 };
  }
  if (hasLast && rosterTokenCount(roster, last, "last") === 1) {
    return { observed: last, score: 0.88, confidence: 0.72 };
  }
  const observedFirst = firstOrAlias.find((token) => filenameTokens.includes(token));
  if (observedFirst && rosterTokenCount(roster, observedFirst, "first") === 1) {
    return { observed: observedFirst, score: 0.84, confidence: 0.7 };
  }
  return null;
}

function filenameNameTokens(filename) {
  const base = String(filename || "")
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  const stop = new Set(["run", "one", "two", "r1", "r2", "mp4", "mov", "m4v"]);
  return normalizeText(base)
    .split(" ")
    .filter((token) => /[a-z]/.test(token) && token.length > 1 && !stop.has(token));
}

function rosterTokenCount(roster, token, position) {
  const needle = normalizeText(token);
  return roster.filter((racer) => {
    const tokens = tokenizeName(racer.name);
    if (position === "first") return tokens[0] === needle || firstNameAliases(tokens[0]).includes(needle);
    if (position === "last") return tokens.at(-1) === needle;
    return tokens.includes(needle);
  }).length;
}

function firstNameAliases(first) {
  const aliases = {
    isabelle: ["izzy"],
    izzy: ["isabelle"]
  };
  return aliases[normalizeText(first)] || [];
}

function isSingleToken(value) {
  return normalizeText(value).split(" ").filter(Boolean).length === 1;
}
