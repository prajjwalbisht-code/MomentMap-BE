"use strict";

const fs = require("fs");
const { execFile } = require("child_process");
const config = require("../config");

const TMDB_API_KEY = config.tmdb.apiKey;
const OUT_FILE = "tmdb_bollywood_upcoming.json";

function tmdbGet(path, params = {}) {
  const searchParams = new URLSearchParams({
    api_key: TMDB_API_KEY,
    ...params,
  });

  const url = `https://api.themoviedb.org/3${path}?${searchParams.toString()}`;

  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-s", url],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout.toString()));
        } catch (e) {
          reject(new Error(`Invalid TMDb JSON: ${e.message}`));
        }
      }
    );
  });
}

async function fetchBollywoodUpcoming(page = 1, today) {
  return tmdbGet("/discover/movie", {
    with_original_language: "hi",
    region: "IN",
    "primary_release_date.gte": today,
    sort_by: "popularity.desc",
    include_adult: "false",
    include_video: "false",
    page: String(page),
  });
}

async function runTmdbFetcher() {
  if (!TMDB_API_KEY) {
    throw new Error('Set TMDB_API_KEY first, e.g. export TMDB_API_KEY="your_tmdb_api_key"');
  }

  const today = new Date().toISOString().split("T")[0];
  const allResults = [];

  console.log("Fetching TMDb popular Bollywood movies (2025–2026 window)...");

  for (let page = 1; page <= 5; page++) {
    console.log(`  Page ${page}...`);
    try {
      const data = await fetchBollywoodUpcoming(page, today);
      const results = Array.isArray(data.results) ? data.results : [];
      allResults.push(...results);
      if (page >= (data.total_pages || 1)) break;
    } catch (e) {
      console.warn(`  ⚠️ TMDb fetch failed for page=${page}: ${e.message}`);
      break;
    }
  }

  const seen = new Set();
  const deduped = allResults.filter((m) => {
    if (!m || !m.id) return false;
    if (seen.has(m.id)) return false;
    seen.add(m.id);

    // Local filter: keep only movies with year 2025 or 2026 if we can parse it.
    const d = m.release_date || m.first_air_date || "";
    const match = d.match(/^(\d{4})-/);
    if (match) {
      const year = parseInt(match[1], 10);
      if (year < 2025 || year > 2026) return false;
    }
    // Popularity floor: keep only reasonably popular titles.
    const pop = m.popularity || 0;
    return pop >= 2.5;
  });

  deduped.sort((a, b) => {
    const pa = a.popularity || 0;
    const pb = b.popularity || 0;
    if (pb !== pa) return pb - pa;
    return (b.vote_count || 0) - (a.vote_count || 0);
  });

  const out = {
    meta: {
      generated_at: new Date().toISOString(),
      source: "TMDb /discover/movie",
      region: "IN",
      language: "hi",
      release_years: "2025-2026+upcoming",
      total: deduped.length,
    },
    items: deduped,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${deduped.length} Bollywood 2025–2026 movies to ${OUT_FILE}`);
}

module.exports = { runTmdbFetcher };
