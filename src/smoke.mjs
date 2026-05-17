import { loadConfig } from "./config.mjs";
import { JsonStore } from "./lib/fsStore.mjs";
import { detectTranscriptionBackends } from "./adapters/transcription.mjs";
import { matchFolderToLiveTimingRaces, parseLiveTimingRacePayload } from "./adapters/events.mjs";
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

const cameraFilenameLabels = deterministicLabels(
  {
    filename: "P1000251.MP4",
    transcript: { text: "Jack, run one." }
  },
  {
    candidateRoster: [
      { name: "Jack Baker", bib: "78", team: "TPT", club: "Team Palis" },
      { name: "Charlotte Anderson", bib: "4", team: "TPT", club: "Team Palis" },
      { name: "Nolan Boone", bib: "51", team: "TPT", club: "Team Palis" }
    ]
  }
);

if (cameraFilenameLabels.length !== 1 || cameraFilenameLabels[0].name !== "Jack Baker") {
  throw new Error("Camera filename should not be treated as a bib label.");
}

const ambiguousLabels = deterministicLabels(
  {
    filename: "clip.mp4",
    transcript: { text: "Hannah, run one." }
  },
  {
    candidateRoster: [
      { name: "Hannah Davidson", bib: "19", team: "TPT", club: "Team Palis" },
      { name: "Hannah Leopold", bib: "79", team: "TPT", club: "Team Palis" }
    ]
  }
);

if (ambiguousLabels.length !== 2 || ambiguousLabels.some((label) => label.confidence >= 0.65)) {
  throw new Error("Ambiguous one-word roster matches should require review.");
}

const normalizedLabels = deterministicLabels(
  {
    filename: "clip.mp4",
    transcript: { text: "Alice!" }
  },
  {
    candidateRoster: [
      { name: "Alex Wong", bib: "73", team: "TPT", club: "Team Palis" },
      { name: "Alice Nam", bib: "70", team: "TPT", club: "Team Palis" }
    ]
  }
);

const aliceLabel = normalizedLabels.find((label) => label.name === "Alice Nam");
const alexLabel = normalizedLabels.find((label) => label.name === "Alex Wong");
const probabilitySum = normalizedLabels.reduce((sum, label) => sum + (label.probability || label.confidence || 0), 0);
if (!aliceLabel || !alexLabel || Math.abs(probabilitySum - 1) > 0.001 || aliceLabel.probability <= alexLabel.probability) {
  throw new Error("Roster candidate probabilities should normalize raw fuzzy scores across athletes.");
}

const filenameRosterLabels = deterministicLabels(
  {
    filename: "IzzyBronitsky_run2.MOV",
    transcript: { text: "" }
  },
  {
    candidateRoster: [
      { name: "Isabelle Bronitsky", bib: "44", team: "TPT", club: "Team Palis" },
      { name: "Isabelle Qin", bib: "69", team: "TPT", club: "Team Palis" }
    ]
  }
);

if (filenameRosterLabels[0]?.name !== "Isabelle Bronitsky" || filenameRosterLabels[0]?.confidence < 0.65) {
  throw new Error("Filename roster matching should use local filename hints without media downloads.");
}

const racePayload = parseLiveTimingRacePayload(
  "1=0=1=N=30|hN=U=CA Challenge Series |hT=Giant Slalom=Women|hC=USA=CA|hR=Northstar Resort|hST=1/9/2026 9:00 AM|hID=297652|hE|b=49|m=Yuan, Vivian|t=TPT|c=Team Palis|s=U14|un=F7062977|endC|~",
  "https://www.live-timing.com/includes/aj_race.php?r=297652"
);

if (racePayload.roster[0]?.name !== "Vivian Yuan" || racePayload.race?.raceId !== "297652") {
  throw new Error("Live-Timing race payload parser smoke test failed.");
}

const raceMatches = matchFolderToLiveTimingRaces(
  {
    name: "GS Race Jan 9. Northstar. Day 1",
    path: "",
    eventMatch: { date: "2026-01-09", venue: "Northstar", discipline: "GS" }
  },
  [
    racePayload.race,
    { ...racePayload.race, raceId: "297661", gender: "Men", sourceUrl: "https://www.live-timing.com/race2.php?r=297661" }
  ]
);

if (raceMatches.length !== 2) {
  throw new Error("Live-Timing sibling gender race matching smoke test failed.");
}

const backends = await detectTranscriptionBackends(config);
console.log(JSON.stringify({
  ok: true,
  store: store.storePath,
  transcriptionBackends: backends
}, null, 2));
