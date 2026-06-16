"use client";

import { useEffect, useMemo, useState } from "react";

const statusLabels = {
  indexed: "Indexed",
  needs_review: "Review"
};

export default function PublicIndexPage() {
  const [index, setIndex] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState("all");

  useEffect(() => {
    let cancelled = false;
    fetch("/data/lean-index.json")
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load index (${response.status})`);
        return response.json();
      })
      .then((payload) => {
        if (!cancelled) setIndex(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const foldersById = useMemo(() => new Map((index?.folders || []).map((folder) => [folder.id, folder])), [index]);
  const folders = useMemo(() => (index?.folders || []).filter((folder) => folder.stats?.publishedVideos > 0), [index]);
  const videos = index?.videos || [];
  const normalizedQuery = normalize(query);

  const results = useMemo(() => {
    const filtered = videos.filter((video) => {
      if (selectedFolderId !== "all" && video.folderId !== selectedFolderId) return false;
      if (!normalizedQuery) return true;
      const folder = foldersById.get(video.folderId);
      return normalize([
        video.filename,
        video.transcript?.text,
        video.goldenLabel?.name,
        video.goldenLabel?.evidence,
        folder?.name,
        folder?.eventMatch?.canonicalName,
        ...(video.athleteLabels || []).flatMap((label) => [label.name, label.evidence])
      ].join(" ")).includes(normalizedQuery);
    });
    return filtered
      .sort((a, b) => {
        const folderA = foldersById.get(a.folderId);
        const folderB = foldersById.get(b.folderId);
        return String(folderA?.eventDate || folderA?.name || "").localeCompare(String(folderB?.eventDate || folderB?.name || ""))
          || String(a.filename).localeCompare(String(b.filename));
      })
      .slice(0, 300);
  }, [foldersById, normalizedQuery, selectedFolderId, videos]);

  const totalIndexed = videos.filter((video) => video.processing?.status === "indexed").length;
  const labeledVideos = videos.filter((video) => video.goldenLabel || video.athleteLabels?.length).length;
  const rootShareUrl = index?.teams?.[0]?.folderUrl || index?.teams?.[0]?.sharepointRootUrl || "";

  if (error) {
    return (
      <main className="shell">
        <section className="notice error">{error}</section>
      </main>
    );
  }

  if (!index) {
    return (
      <main className="shell">
        <section className="notice">Loading public video index...</section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Team Palisades Tahoe</p>
          <h1>U14 Video Index</h1>
        </div>
        <div className="exportMeta">
          <span>{index.teams?.[0]?.season || "2025-2026"}</span>
          <span>{formatDateTime(index.exportedAt)}</span>
        </div>
      </header>

      <section className="summary" aria-label="Index summary">
        <Metric label="Events" value={folders.length} />
        <Metric label="Videos" value={videos.length} />
        <Metric label="Indexed" value={totalIndexed} />
        <Metric label="With Names" value={labeledVideos} />
      </section>

      {rootShareUrl && (
        <section className="sharepointNotice" aria-label="SharePoint access note">
          <p>
            SharePoint may ask for sign-in until your browser has opened the public team folder once. Open it once,
            then return here and video links should open directly.
          </p>
          <a href={rootShareUrl} rel="noreferrer" target="_blank">
            Open Public Team Folder
          </a>
        </section>
      )}

      <section className="searchRow" aria-label="Search controls">
        <label className="searchBox">
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Athlete, event, filename, transcript text"
            type="search"
          />
        </label>
        <label className="folderPicker">
          <span>Event</span>
          <select value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}>
            <option value="all">All published events</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {eventLabel(folder)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="contentGrid">
        <aside className="eventList" aria-label="Events">
          <div className="sectionHeader">
            <h2>Events</h2>
            <span>{folders.length}</span>
          </div>
          <div className="events">
            {folders.map((folder) => (
              <button
                className={`eventRow ${selectedFolderId === folder.id ? "selected" : ""}`}
                key={folder.id}
                onClick={() => setSelectedFolderId(folder.id)}
                type="button"
              >
                <span className="eventDate">{shortDate(folder.eventDate || folder.timeCreated)}</span>
                <span className="eventName">{folder.eventMatch?.canonicalName || folder.name}</span>
                <span className="eventCounts">
                  {folder.stats?.indexedVideos || 0}/{folder.stats?.publishedVideos || 0}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="results" aria-label="Search results">
          <div className="sectionHeader">
            <h2>Videos</h2>
            <span>{results.length}{results.length === 300 ? "+" : ""}</span>
          </div>
          {results.length ? (
            <div className="resultList">
              {results.map((video) => (
                <VideoResult
                  folder={foldersById.get(video.folderId)}
                  key={video.id}
                  video={video}
                />
              ))}
            </div>
          ) : (
            <div className="empty">No videos match the current search.</div>
          )}
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function VideoResult({ video, folder }) {
  const labels = finalLabels(video);
  const primaryLabel = labels[0];
  const videoUrl = video.playbackUrl || video.sharepointUrl;
  return (
    <article className="videoRow">
      <div className="videoMain">
        <div className="videoTitleRow">
          <h3>{primaryLabel?.name || "Unlabeled skier"}</h3>
          <span className={`status ${video.processing?.status || "pending"}`}>
            {statusLabels[video.processing?.status] || video.processing?.status || "Pending"}
          </span>
        </div>
        <p className="filename">{video.filename}</p>
        <p className="eventLine">{eventLabel(folder)}</p>
        {labels.length > 0 && (
          <div className="labelList">
            {labels.slice(0, 4).map((label, index) => (
              <span className="labelPill" key={`${label.name}-${index}`}>
                {label.name} {label.source === "golden_review" ? "Golden" : `${Math.round((label.confidence || 0) * 100)}%`}
              </span>
            ))}
          </div>
        )}
        {video.transcript?.text && <p className="transcript">{video.transcript.text}</p>}
      </div>
      <div className="videoActions">
        <a href={videoUrl} rel="noreferrer" target="_blank">
          Open Video
        </a>
        {folder?.sharepointUrl && (
          <a className="secondary" href={folder.sharepointUrl} rel="noreferrer" target="_blank">
            Event Folder
          </a>
        )}
      </div>
    </article>
  );
}

function finalLabels(video) {
  const predictions = video.athleteLabels || [];
  return video.goldenLabel ? [video.goldenLabel, ...predictions] : predictions;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function eventLabel(folder) {
  if (!folder) return "Unknown event";
  const date = shortDate(folder.eventDate || folder.timeCreated);
  const name = folder.eventMatch?.canonicalName || folder.name;
  return date ? `${date} · ${name}` : name;
}

function shortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}
