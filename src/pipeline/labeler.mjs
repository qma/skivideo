import { includesName, normalizeText } from "../lib/text.mjs";
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

  for (const racer of roster) {
    const inTranscript = includesName(transcriptText, racer.name);
    const inFilename = includesName(filename.replace(/[_-]/g, " "), racer.name);
    const bibMatch = racer.bib && new RegExp(`(^|[^0-9])0*${escapeRegExp(racer.bib)}([^0-9]|$)`).test(filename);
    const fuzzy = bestFuzzyRosterMatch(transcriptText, racer);
    const fuzzyMatch = fuzzy && fuzzy.score >= 0.76;
    if (!(inTranscript || inFilename || bibMatch || fuzzyMatch)) continue;
    const confidence = inTranscript ? 0.86 : inFilename ? 0.7 : bibMatch ? 0.58 : Math.min(0.68, fuzzy.score * 0.78);
    labels.push({
      name: racer.name,
      confidence,
      source: inTranscript ? "audio_transcript" : inFilename ? "filename_context" : bibMatch ? "bib_filename_context" : "fuzzy_audio_roster_match",
      evidence: inTranscript
        ? evidenceSnippet(transcriptText, racer.name)
        : fuzzyMatch
          ? `Transcript heard "${fuzzy.observed}", fuzzy-matched to roster name ${racer.name}`
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
