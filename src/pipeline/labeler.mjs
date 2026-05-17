import { includesName, normalizeText, tokenizeName } from "../lib/text.mjs";
import { bestFuzzyRosterMatch } from "../lib/fuzzyNames.mjs";

export async function labelVideoAthletes(config, video, folder, store) {
  const result = await labelVideoAthletesWithDebug(config, video, folder, store);
  return result.labels;
}

export async function labelVideoAthletesWithDebug(config, video, folder, store) {
  const heuristic = heuristicLabelsWithDebug(video, folder);
  const debug = heuristic.debug;
  const heuristicLabelsOnly = heuristic.labels;

  if (config.geminiApiKey && (process.env.LLM_LABEL_MODE === "always" || !heuristicLabelsOnly.length)) {
    try {
      const geminiLabels = await labelWithGemini(config, video, folder, store);
      const labels = mergeLabels(heuristicLabelsOnly, geminiLabels);
      debug.gemini = { mode: process.env.LLM_LABEL_MODE === "always" ? "always" : "fallback", labels: geminiLabels.length };
      debug.finalLabels = labels.map(debugLabelSummary);
      return { labels, debug };
    } catch (error) {
      debug.notes.push(`Gemini labeling failed: ${error.message}`);
    }
  }

  if (config.openaiApiKey && process.env.LLM_LABEL_MODE === "always") {
    const openAiLabels = await labelWithOpenAi(config, video, folder);
    const labels = mergeLabels(heuristicLabelsOnly, openAiLabels);
    debug.openAi = { mode: "always", labels: openAiLabels.length };
    debug.finalLabels = labels.map(debugLabelSummary);
    return { labels, debug };
  }
  if (heuristicLabelsOnly.length || !config.openaiApiKey) {
    debug.openAi = { mode: config.openaiApiKey ? "skipped_deterministic_found_labels" : "unavailable" };
    debug.finalLabels = heuristicLabelsOnly.map(debugLabelSummary);
    return { labels: heuristicLabelsOnly, debug };
  }
  const labels = await labelWithOpenAi(config, video, folder);
  debug.openAi = { mode: "fallback_no_deterministic_labels", labels: labels.length };
  debug.finalLabels = labels.map(debugLabelSummary);
  return { labels, debug };
}

export function heuristicLabels(video, folder) {
  return heuristicLabelsWithDebug(video, folder).labels;
}

function heuristicLabelsWithDebug(video, folder) {
  const transcriptText = video.transcript?.text || "";
  const filename = video.filename || "";
  const roster = folder?.candidateRoster || [];
  const labels = [];
  const rosterLabelEntries = [];
  const debug = {
    methodVersion: "heuristic-v1",
    transcriptChars: transcriptText.length,
    filename,
    rosterSize: roster.length,
    rosterCandidates: [],
    extractedNames: [],
    notes: []
  };
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
    const candidate = {
      name: racer.name,
      bib: racer.bib || "",
      team: racer.team || racer.club || "",
      checks: {
        exactTranscript: Boolean(inTranscript),
        exactFilename: Boolean(inFilename),
        filenameRoster: Boolean(filenameRosterMatch),
        bibFilename: Boolean(bibMatch),
        fuzzyTranscript: Boolean(fuzzyMatch),
        ambiguousFuzzy: Boolean(ambiguousFuzzy)
      },
      fuzzy: fuzzy ? { observed: fuzzy.observed, score: Number(fuzzy.score.toFixed(3)) } : null,
      filenameRoster: filenameRoster ? {
        observed: filenameRoster.observed,
        score: Number(filenameRoster.score.toFixed(3)),
        confidence: Number(filenameRoster.confidence.toFixed(3))
      } : null,
      selected: false,
      confidence: 0,
      rawScore: candidateRawScore({ inTranscript, inFilename, filenameRoster, filenameRosterMatch, bibMatch, fuzzy, fuzzyMatch }),
      probability: 0,
      source: ""
    };
    if (!(inTranscript || inFilename || filenameRosterMatch || bibMatch || fuzzyMatch)) {
      if (candidate.fuzzy?.score >= 0.62 || candidate.filenameRoster?.score >= 0.72) debug.rosterCandidates.push(candidate);
      continue;
    }
    const confidence = inTranscript ? 0.86 : inFilename ? 0.7 : filenameRosterMatch ? filenameRoster.confidence : bibMatch ? 0.58 : ambiguousFuzzy ? 0.52 : Math.min(0.68, fuzzy.score * 0.78);
    const source = inTranscript ? "audio_transcript" : inFilename ? "filename_context" : filenameRosterMatch ? "filename_roster_match" : bibMatch ? "bib_filename_context" : ambiguousFuzzy ? "fuzzy_audio_roster_ambiguous" : "fuzzy_audio_roster_match";
    candidate.selected = true;
    candidate.confidence = Number(confidence.toFixed(3));
    candidate.source = source;
    candidate.reason = scoreReason(candidate);
    debug.rosterCandidates.push(candidate);
    const label = {
      name: racer.name,
      confidence,
      probability: confidence,
      rawScore: candidate.rawScore,
      source,
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
      debug: scoreReason(candidate),
      methodVersion: "deterministic-v2"
    };
    rosterLabelEntries.push({ label, candidate });
    labels.push(label);
  }

  normalizeRosterProbabilities(rosterLabelEntries);

  if (!labels.length) {
    const possible = inferCapitalizedNames(transcriptText);
    for (const name of possible) {
      const extracted = {
        name,
        source: "audio_transcript_unmatched_name",
        confidence: 0.42,
        evidence: evidenceSnippet(transcriptText, name)
      };
      debug.extractedNames.push(extracted);
      labels.push({
        name,
        confidence: 0.42,
        source: "audio_transcript_unmatched_name",
        evidence: extracted.evidence,
        matchedRoster: false,
        debug: "No roster match; extracted capitalized full-name phrase from transcript.",
        methodVersion: "deterministic-v2"
      });
    }
  }

  if (!labels.length) {
    for (const name of inferSingleWordCallouts(transcriptText)) {
      const extracted = {
        name,
        source: "audio_transcript_single_word",
        confidence: 0.32,
        evidence: evidenceSnippet(transcriptText, name)
      };
      debug.extractedNames.push(extracted);
      labels.push({
        name,
        confidence: 0.32,
        source: "audio_transcript_single_word",
        evidence: extracted.evidence,
        matchedRoster: false,
        debug: "No roster match; extracted single capitalized callout from transcript.",
        methodVersion: "deterministic-v2"
      });
    }
  }

  const finalLabels = dedupeLabels(labels).sort((a, b) => b.confidence - a.confidence);
  debug.rosterCandidates = debug.rosterCandidates
    .sort((a, b) => Number(b.selected) - Number(a.selected) || (b.probability || 0) - (a.probability || 0) || (b.rawScore || 0) - (a.rawScore || 0) || (b.fuzzy?.score || 0) - (a.fuzzy?.score || 0))
    .slice(0, 12);
  debug.finalLabels = finalLabels.map(debugLabelSummary);
  if (!finalLabels.length) debug.notes.push("No label met deterministic exact, filename, bib, or fuzzy thresholds.");
  return { labels: finalLabels, debug };
}

async function labelWithGemini(config, video, folder, store) {
  const state = await store.read();
  const promptTemplate = state.settings?.labelPrompt || "";
  if (!promptTemplate) return [];

  const rosterText = (folder?.candidateRoster || [])
    .map((racer) => `${racer.name}${racer.bib ? ` bib ${racer.bib}` : ""}${racer.team || racer.club ? ` team ${racer.team || racer.club}` : ""}`)
    .join("\n");

  const prompt = promptTemplate
    .replaceAll("{{roster}}", rosterText)
    .replaceAll("{{filename}}", video.filename || "")
    .replaceAll("{{transcript}}", video.transcript?.text || "")
    .replaceAll("{{venue}}", folder?.eventMatch?.venue || "unknown")
    .replaceAll("{{discipline}}", folder?.eventMatch?.discipline || "unknown")
    .replaceAll("{{date}}", folder?.eventMatch?.date || "unknown");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiLabelModel}:generateContent?key=${config.geminiApiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini API failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  const parsed = JSON.parse(text);
  const labels = Array.isArray(parsed) ? parsed : (parsed.labels || []);

  return labels.map((label) => ({
    ...label,
    confidence: label.probability || 0,
    source: "gemini_llm_audio_roster_reasoning",
    methodVersion: `gemini-${config.geminiLabelModel}-v1`
  }));
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

function scoreReason(candidate) {
  const checks = candidate.checks || {};
  const matched = [];
  if (checks.exactTranscript) matched.push("exact transcript name");
  if (checks.exactFilename) matched.push("exact filename name");
  if (checks.filenameRoster) matched.push(`filename token "${candidate.filenameRoster?.observed}" matched roster`);
  if (checks.bibFilename) matched.push("bib matched filename");
  if (checks.fuzzyTranscript) matched.push(`transcript "${candidate.fuzzy?.observed}" fuzzy ${candidate.fuzzy?.score}`);
  if (checks.ambiguousFuzzy) matched.push("ambiguous single-token fuzzy match");
  const probability = Number.isFinite(candidate.probability) && candidate.probability > 0
    ? `${Math.round(candidate.probability * 100)}% probability`
    : `${Math.round((candidate.confidence || 0) * 100)}%`;
  const raw = Number.isFinite(candidate.rawScore) && candidate.rawScore > 0
    ? `raw ${Number(candidate.rawScore.toFixed(3))}`
    : "raw 0";
  return `${candidate.name}: ${matched.join("; ") || "no selected checks"} -> ${probability} (${raw}) ${candidate.source || ""}`.trim();
}

function debugLabelSummary(label) {
  return {
    name: label.name,
    confidence: Number((Number(label.confidence) || 0).toFixed(3)),
    probability: Number((Number(label.probability ?? label.confidence) || 0).toFixed(3)),
    rawScore: Number((Number(label.rawScore) || 0).toFixed(3)),
    source: label.source || "",
    debug: label.debug || label.evidence || ""
  };
}

function candidateRawScore({ inTranscript, inFilename, filenameRoster, filenameRosterMatch, bibMatch, fuzzy, fuzzyMatch }) {
  const scores = [];
  if (inTranscript) scores.push(2);
  if (inFilename) scores.push(2);
  if (filenameRosterMatch) scores.push(filenameRoster.score || filenameRoster.confidence || 0);
  if (bibMatch) scores.push(1.2);
  if (fuzzyMatch) scores.push(fuzzy.score || 0);
  return Math.max(0, ...scores);
}

function normalizeRosterProbabilities(entries) {
  const selected = entries.filter((entry) => entry.candidate.selected && entry.candidate.rawScore > 0);
  if (!selected.length) return;
  const total = selected.reduce((sum, entry) => sum + Math.exp(entry.candidate.rawScore), 0);
  for (const entry of selected) {
    const probability = Math.exp(entry.candidate.rawScore) / total;
    entry.candidate.probability = Number(probability.toFixed(6));
    entry.candidate.confidence = Number(probability.toFixed(6));
    entry.label.probability = probability;
    entry.label.confidence = probability;
    entry.label.rawScore = entry.candidate.rawScore;
    entry.candidate.reason = scoreReason(entry.candidate);
    entry.label.debug = entry.candidate.reason;
  }
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
