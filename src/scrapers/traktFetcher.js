"use strict";

const fs = require("fs");
const { execFile } = require("child_process");
const config = require("../config");

const TRAKT_CLIENT_ID = config.trakt.clientId;
const OUT_FILE = "trakt_genz_upcoming.json";

const GENRES = "action,adventure,comedy,horror,science-fiction,thriller,animation";

function traktGet(path, query = "") {
  const url = query
    ? `https://api.trakt.tv${path}?${query}`
    : `https://api.trakt.tv${path}`;
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "-s",
        "-H", "Content-Type: application/json",
        "-H", `trakt-api-key: ${TRAKT_CLIENT_ID}`,
        "-H", "trakt-api-version: 2",
        url,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout.toString()));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      }
    );
  });
}

async function runTraktFetcher() {
  if (!TRAKT_CLIENT_ID) {
    throw new Error("Set TRAKT_CLIENT_ID (e.g. export TRAKT_CLIENT_ID=your-client-id)");
  }

  const today = new Date().toISOString().split("T")[0];

  console.log("Fetching Trakt anticipated movies (GenZ-relevant genres)...");
  const query = GENRES ? `genres=${GENRES}&limit=50` : "limit=50";
  const raw = await traktGet("/movies/anticipated", query);

  const items = Array.isArray(raw) ? raw : [];
  const withRelease = items
    .map((entry) => {
      const movie = entry.movie || entry;
      const released = movie.released || entry.released || null;
      return {
        list_count: entry.list_count,
        ...movie,
        released,
      };
    })
    .filter((m) => {
      const released = m.released || "";
      return !released || released >= today;
    })
    .sort((a, b) => (b.list_count || 0) - (a.list_count || 0));

  const out = {
    meta: {
      generated_at: new Date().toISOString(),
      source: "Trakt /movies/anticipated",
      genres_filter: GENRES || "all",
      total: withRelease.length,
    },
    items: withRelease,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${withRelease.length} anticipated (upcoming) movies to ${OUT_FILE}`);
}

module.exports = { runTraktFetcher };
