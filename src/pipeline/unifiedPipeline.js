"use strict";

const fs = require("fs");
const path = require("path");
const { runTmdbFetcher } = require("../scrapers/tmdbFetcher");
const { runTraktFetcher } = require("../scrapers/traktFetcher");
const { listObjectsInS3, getObjectFromS3, uploadToS3 } = require("../services/s3Service");
const { matchProductObjects } = require("../services/productService");
const { generateEventId } = require("../utils/slugify");
const { enrichTraktMovie } = require("../../aiService_trakt");
const { enrichGeneralEvent } = require("../../aiService_event");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TMDB_OUT = "tmdb_bollywood_upcoming.json";
const TRAKT_OUT = "trakt_genz_upcoming.json";

async function runUnifiedPipeline(options = { dryRun: false }) {
  console.log("\n🚀 Starting Unified Event Pipeline...");

  // 1. SYNC S3 INDEX (Deduplication)
  const existingIds = await buildS3EventIndex();
  console.log(`📡 Synced S3 index. Found ${existingIds.size} existing events.`);

  // 2. RUN FETCHERS
  console.log("📥 Running fetchers...");
  await runTmdbFetcher();
  await runTraktFetcher();

  // 3. LOAD, NORMALIZE IDs, & DIFF
  const tmdbData = JSON.parse(fs.readFileSync(TMDB_OUT, "utf-8"));
  const traktData = JSON.parse(fs.readFileSync(TRAKT_OUT, "utf-8"));

  // TMDb normalization
  tmdbData.items.forEach(m => {
    m._id = m.id; // Keep original TMDb ID
    m.id = generateEventId(m.title, m.release_date);
    m.date = m.release_date;
  });

  // Trakt normalization
  traktData.items.forEach(entry => {
    const movie = entry.movie || entry;
    const released = movie.released || entry.released || "";
    entry.id = generateEventId(movie.title, released);
    entry.date = released;
  });

  const newTmdb = tmdbData.items.filter(m => !existingIds.has(m.id));
  const newTrakt = traktData.items.filter(m => !existingIds.has(m.id));

  console.log(`✨ Found ${newTmdb.length} new TMDb movies and ${newTrakt.length} new Trakt movies.`);

  if (newTmdb.length === 0 && newTrakt.length === 0) {
    console.log("✅ No new events to process. Done.");
    return;
  }

  // 4. AI ENRICHMENT (Sequential to avoid rate limits)
  const processedEvents = [];

  console.log("🧠 Processing new Trakt movies through AI...");
  for (const item of newTrakt) {
    try {
      const enriched = await enrichTraktMovie(item);
      processedEvents.push(enriched);
    } catch (e) {
      console.error(`  ❌ Failed to enrich Trakt movie: ${e.message}`);
    }
  }

  console.log("🧠 Processing new TMDb movies through AI...");
  for (const item of newTmdb) {
    try {
      const enriched = await enrichTraktMovie(item);
      processedEvents.push(enriched);
    } catch (e) {
      console.error(`  ❌ Failed to enrich TMDb movie: ${e.message}`);
    }
  }

  // 5. PRODUCT MATCHING
  console.log("🛍️  Matching products for new events...");
  for (const event of processedEvents) {
    if (event.fashion_keywords) {
      event.products = await matchProductObjects(event);
    } else {
      event.products = [];
    }
  }

  // 6. S3 PERSISTENCE (Group by Month/Day)
  if (options.dryRun) {
    console.log("🔵 DRY RUN — printing summary only.");
    fs.writeFileSync("pipeline_dry_run.json", JSON.stringify(processedEvents, null, 2));
    return;
  }

  console.log("☁️  Uploading to S3...");
  const grouped = groupByDate(processedEvents);
  for (const [sKey, events] of Object.entries(grouped)) {
    await mergeAndUploadToS3(sKey, events);
  }

  console.log("\n✅ Pipeline completed successfully.");
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function buildS3EventIndex() {
  const ids = new Set();
  const objects = await listObjectsInS3("");
  const dayFilePattern = /^\d{4}-\d{2}\/\d{2}\.json$/;
  const dayKeys = objects.filter(o => dayFilePattern.test(o.Key)).map(o => o.Key);

  for (const key of dayKeys) {
    try {
      const content = await getObjectFromS3(key);
      const data = JSON.parse(content);
      (data.events || []).forEach(e => {
        if (e.id) ids.add(e.id);
      });
    } catch (e) {
      console.warn(`  ⚠️  Failed to read day file ${key}: ${e.message}`);
    }
  }
  return ids;
}

function groupByDate(events) {
  const groups = {};
  events.forEach(e => {
    const dateStr = e.date || "unknown"; // "YYYY-MM-DD" expected
    if (dateStr === "unknown" || dateStr === "Upcoming") return;

    // Normalize "YYYY-MM-DD" to S3 key "YYYY-MM/DD.json"
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return;

    const sKey = `${match[1]}-${match[2]}/${match[3]}.json`;
    if (!groups[sKey]) groups[sKey] = [];
    groups[sKey].push(e);
  });
  return groups;
}

async function mergeAndUploadToS3(sKey, newEvents) {
  let existingData = { events: [] };
  try {
    const content = await getObjectFromS3(sKey);
    if (content) existingData = JSON.parse(content);
  } catch (e) {
    // File doesn't exist yet, that's fine
  }

  // Merge (unique by id)
  const eventMap = new Map();
  existingData.events.forEach(e => eventMap.set(e.id, e));
  newEvents.forEach(e => eventMap.set(e.id, e));

  const finalData = {
    events: Array.from(eventMap.values()),
    last_updated: new Date().toISOString()
  };

  await uploadToS3(sKey, JSON.stringify(finalData, null, 2), "application/json");
  console.log(`  ✅ Synced: ${sKey} (+${newEvents.length} items)`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  runUnifiedPipeline({ dryRun }).catch(err => {
    console.error("❌ Pipeline crashed:", err.message);
    process.exit(1);
  });
}

module.exports = { runUnifiedPipeline };
