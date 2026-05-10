import { loadConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { detectTranscriptionBackends } from "./adapters/transcription.mjs";
import { deterministicLabels } from "./pipeline/labeler.mjs";

const config = loadConfig();
const store = new JsonStore(config);
await store.ensure();

const labels = deterministicLabels(
  {
    filename: "bib42_jane_smith_run1.mp4",
    transcript: { text: "Next up is Jane Smith, bib forty two." }
  },
  {
    candidateRoster: [{ name: "Jane Smith", bib: "42", club: "PT" }]
  }
);

if (!labels.length || labels[0].name !== "Jane Smith") {
  throw new Error("Deterministic labeler smoke test failed.");
}

const backends = await detectTranscriptionBackends(config);
console.log(JSON.stringify({
  ok: true,
  store: store.storePath,
  transcriptionBackends: backends
}, null, 2));
