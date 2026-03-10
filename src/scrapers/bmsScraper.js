"use strict";

const puppeteer = require("puppeteer");
const fs = require("fs");
const config = require("../config");
const { uploadToS3, listObjectsInS3, getObjectFromS3 } = require("../services/s3Service");
const { enrichEventWithFashion } = require("../services/aiService");
const { matchProducts } = require("../services/productService");
const { generateEventId } = require("../utils/slugify");

// ─── LISTING URLs ──────────────────────────────────────────────────────────────
const CATEGORIES = [
    { category: "Movies", emoji: "🎬", url: "https://in.bookmyshow.com/explore/movies-bengaluru" },
    { category: "Online Streams", emoji: "🎥", url: "https://in.bookmyshow.com/explore/c/stream" },
    { category: "Events", emoji: "🎪", url: "https://in.bookmyshow.com/explore/events-bengaluru" },
    { category: "Plays", emoji: "🎭", url: "https://in.bookmyshow.com/explore/plays-bengaluru" },
    { category: "Sports", emoji: "🏏", url: "https://in.bookmyshow.com/explore/sports-bengaluru" },
    { category: "Activities", emoji: "🧗", url: "https://in.bookmyshow.com/explore/activities-bengaluru" },
];

// ─── SELECTORS ────────────────────────────────────────────────────────────────
const LISTING = {
    cardLink: "a.sc-1ljcxl3-1",
    title: ".sc-7o7nez-0.beUxEp",
    meta: ".sc-7o7nez-0.bDUeYX",
};

const DETAIL = {
    title: "h1.sc-qswwm9-6.hxRESa",
    metaBlock: "div.sc-2k6tnd-0.gSHosf",
    description: "div.sc-o4g232-3.gseldT",
    interested: "div.sc-1h5m8q1-1.bjRuon",
    cast: "div.sc-tesakv-3.dpncct",
};

// ─── GEN Z SCORING ────────────────────────────────────────────────────────────
const GENZ_KEYWORDS = {
    "dj": 3, "edm": 3, "rave": 3, "techno": 3, "hiphop": 3, "hip hop": 3,
    "hip-hop": 3, "trap": 3, "k-pop": 3, "kpop": 3, "anime": 3, "cosplay": 3,
    "esports": 3, "gaming": 3, "open mic": 3, "stand-up": 3,
    "standup": 3, "stand up": 3, "comedy": 3, "roast": 3, "drag": 3,
    "music festival": 2, "indie": 2, "underground": 2, "live music": 2,
    "fest": 2, "pop": 2, "rap": 2, "r&b": 2, "punk": 2, "rock": 2,
    "metal": 2, "electronic": 2, "college": 2, "student": 2, "youth": 2,
    "spoken word": 2, "queer": 2, "party": 2,
    "club": 2, "outdoor": 2, "jam": 2, "battle": 2, "sci-fi": 2,
    "thriller": 1, "horror": 1, "action": 1, "fantasy": 1,
    "film": 1, "screening": 1, "stream": 1, "trending": 1,
};

const CATEGORY_BASE = {
    "Movies": 1, "Online Streams": 2, "Events": 2,
    "Plays": 0, "Sports": 1, "Activities": 2,
};

function getGenZScore(text, category) {
    const lower = (text || "").toLowerCase();
    let score = CATEGORY_BASE[category] || 0;
    for (const [kw, pts] of Object.entries(GENZ_KEYWORDS)) {
        if (lower.includes(kw)) score += pts;
    }
    return score;
}

function genZLabel(score) {
    if (score >= 6) return "🔥 Very High";
    if (score >= 4) return "✅ High";
    if (score >= 2) return "🟡 Moderate";
    return "⬜ Low";
}

// ─── PARSE META BLOCK ─────────────────────────────────────────────────────────
function parseMetaBlock(text) {
    if (!text) return {};
    const parts = text.split("•").map((s) => s.trim()).filter(Boolean);
    const result = { duration: null, genres: null, certification: null, date: null, language: null, format: null };

    for (const part of parts) {
        if (/^\d+h(\s\d+m)?$|^\d+m$/.test(part)) {
            result.duration = part;
        } else if (/^(U|UA|UA\d+\+|A)$/i.test(part)) {
            result.certification = part;
        } else if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2}\/\d{1,2})\b/i.test(part)) {
            result.date = part;
        } else if (/^(2D|3D|IMAX|4DX|ICE|MX4D)$/i.test(part)) {
            result.format = part;
        } else if (/\b(Hindi|English|Kannada|Tamil|Telugu|Malayalam|Bengali|Marathi|Punjabi|Korean|Japanese|French)\b/i.test(part)) {
            result.language = part;
        } else if (part.length > 1 && part.length < 60) {
            result.genres = part;
        }
    }
    return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── BROWSER HELPERS ──────────────────────────────────────────────────────────
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let total = 0;
            const timer = setInterval(() => {
                window.scrollBy(0, 500);
                total += 500;
                if (total >= document.body.scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 250);
        });
    });
    await sleep(1500);
}

async function dismissCityPopup(page) {
    try {
        await page.evaluate(() => {
            const all = [...document.querySelectorAll("li, button, a, div, span, p")];
            const t = all.find((el) => {
                const txt = el.innerText?.trim().toLowerCase();
                return txt === "bengaluru" || txt === "bangalore";
            });
            if (t) t.click();
        });
        await sleep(800);
    } catch (_) { }
}

// ─── PHASE 1: COLLECT LINKS ───────────────────────────────────────────────────
async function getLinks(page, cat) {
    console.log(`\n  ${cat.emoji}  Collecting links: ${cat.category}`);
    try {
        await page.goto(cat.url, { waitUntil: "networkidle2", timeout: 45000 });
    } catch (e) {
        console.warn(`     ⚠️  Failed: ${e.message}`);
        return [];
    }

    await sleep(2500);
    await dismissCityPopup(page);
    await autoScroll(page);

    const links = await page.evaluate((LISTING) => {
        let cards = [...document.querySelectorAll(LISTING.cardLink)];
        if (cards.length === 0) {
            cards = [...document.querySelectorAll("a[href]")].filter((a) =>
                /\/(movies|events|plays|sports|activities|stream)\//i.test(a.href) &&
                a.innerText?.trim().length > 3
            );
        }
        return cards
            .map((a) => ({
                link: a.href,
                quickTitle:
                    a.querySelector(".sc-7o7nez-0.beUxEp")?.innerText?.trim() ||
                    a.querySelector("h3")?.innerText?.trim() || "",
                image: a.querySelector("img")?.src || a.querySelector("img")?.dataset?.src || null,
            }))
            .filter((item) => item.link && item.link.startsWith("http"));
    }, LISTING);

    const seen = new Set();
    const unique = links.filter((l) => {
        if (seen.has(l.link)) return false;
        seen.add(l.link);
        return true;
    });

    console.log(`     🔗 ${unique.length} links found`);
    return unique;
}

// ─── PHASE 2: SCRAPE DETAIL PAGE ──────────────────────────────────────────────
async function scrapeDetail(page, linkObj) {
    try {
        await page.goto(linkObj.link, { waitUntil: "networkidle2", timeout: 30000 });
        await sleep(1500);
    } catch (e) {
        return { title: linkObj.quickTitle, link: linkObj.link, image: linkObj.image, error: e.message };
    }

    return await page.evaluate((DETAIL, linkObj) => {
        const clean = (sel) =>
            document.querySelector(sel)?.innerText?.trim().replace(/\s+/g, " ") || null;

        const title = clean(DETAIL.title) || linkObj.quickTitle || document.title?.split("|")[0]?.trim();
        const metaRaw = clean(DETAIL.metaBlock);
        const description = clean(DETAIL.description);
        const interested = clean(DETAIL.interested);

        const castBlocks = [...document.querySelectorAll(DETAIL.cast)];
        const cast = castBlocks[0] ? castBlocks[0].innerText.trim().replace(/\s+/g, " ") : null;
        const crew = castBlocks[1] ? castBlocks[1].innerText.trim().replace(/\s+/g, " ") : null;

        const img =
            document.querySelector("section img, [class*='poster'] img, [class*='banner'] img, img")?.src ||
            linkObj.image;

        return { title, metaRaw, description, interested, cast, crew, image: img, link: window.location.href };
    }, DETAIL, linkObj);
}

// ─── MAIN EXPORTED FUNCTION ───────────────────────────────────────────────────
async function runScraper() {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  🎟️  BookMyShow Bengaluru — End-to-End Pipeline");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

        // ── Phase 1: Scrape BMS ──────────────────────────────────────────────────
        console.log("📋 PHASE 1 — Collecting event links...");
        const allLinks = [];
        for (const cat of CATEGORIES) {
            const links = await getLinks(page, cat);
            allLinks.push(...links.map(l => ({ ...l, category: cat.category, emoji: cat.emoji })));
            await sleep(1000);
        }

        console.log("\n🔍 PHASE 2 — Scraping details & generating IDs...");
        const allScrapedEvents = [];
        for (let i = 0; i < allLinks.length; i++) {
            const linkObj = allLinks[i];
            const detail = await scrapeDetail(page, linkObj);
            const meta = parseMetaBlock(detail.metaRaw);
            const id = generateEventId(detail.title, meta.date);

            const scoreText = [detail.title, meta.genres, detail.description, meta.language, linkObj.category].join(" ");
            const genZScore = getGenZScore(scoreText, linkObj.category);

            allScrapedEvents.push({
                id,
                category: linkObj.category,
                emoji: linkObj.emoji,
                city: config.pipeline.targetCity,
                title: detail.title,
                date: meta.date,
                duration: meta.duration,
                genres: meta.genres,
                certification: meta.certification,
                language: meta.language,
                description: detail.description,
                cast: detail.cast,
                interested: detail.interested,
                genZScore,
                genZRelevance: genZLabel(genZScore),
                image: detail.image,
                link: detail.link,
            });
            process.stdout.write(".");
        }
        console.log(`\n✅ Scraped ${allScrapedEvents.length} events.`);

        // ── Phase 2: Fetch Existing from S3 ──────────────────────────────────────
        const now = new Date();
        const monthPath = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}/`;
        console.log(`\n☁️  PHASE 3 — Diffing against S3: ${monthPath}`);

        const existingFiles = await listObjectsInS3(monthPath);
        const existingEventsMap = {};

        for (const file of existingFiles) {
            if (file.Key.endsWith(".json")) {
                const content = await getObjectFromS3(file.Key);
                if (content) {
                    try {
                        const data = JSON.parse(content);
                        (data.events || []).forEach(e => { existingEventsMap[e.id] = e; });
                    } catch (e) {
                        console.warn(`⚠️  Failed to parse ${file.Key}`);
                    }
                }
            }
        }

        // ── Phase 3: Diff ────────────────────────────────────────────────────────
        const newEvents = allScrapedEvents.filter(e => !existingEventsMap[e.id] && e.genZScore >= 4);
        console.log(`📊 ${newEvents.length} new events found, ${allScrapedEvents.length - newEvents.length} existing or low-score — skipping.`);

        // ── Phase 4: AI Enrichment & Matching ────────────────────────────────────
        if (newEvents.length > 0) {
            console.log(`\n🤖 PHASE 4 — AI Enrichment & Product Matching...`);
            for (let i = 0; i < newEvents.length; i++) {
                const event = newEvents[i];
                process.stdout.write(`  [${i + 1}/${newEvents.length}] ${event.title.slice(0, 30)}...`);

                // Enrichment with retry
                let enriched = null;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        enriched = await enrichEventWithFashion(event);
                        if (enriched && enriched.fashion_keywords) break;
                    } catch (e) {
                        console.warn(` retry ${attempt}...`);
                    }
                }

                if (enriched) {
                    Object.assign(event, enriched);
                    // Product Matching
                    event.products = await matchProducts(event);
                    console.log(` ✓ (${event.products.length} products)`);
                } else {
                    console.log(" ❌ failed");
                }
                await sleep(500);
            }
        }

        // ── Phase 5: Group & Upload ──────────────────────────────────────────────
        console.log(`\n💾 PHASE 5 — Merging & Uploading to S3...`);
        const groups = {};
        newEvents.forEach(e => {
            const dayMatch = e.id.match(/_(\d{2})_/);
            const day = dayMatch ? dayMatch[1] : String(now.getDate()).padStart(2, '0');
            if (!groups[day]) groups[day] = [];
            groups[day].push(e);
        });

        for (const [day, events] of Object.entries(groups)) {
            const key = `${monthPath}${day}.json`;
            console.log(`  Merging ${events.length} events into ${key}...`);

            let existingContent = await getObjectFromS3(key);
            let dayData = { date: `${monthPath.split('-')[1].replace('/', '')}-${day}`, events: [], last_updated: "" };

            if (existingContent) {
                try {
                    dayData = JSON.parse(existingContent);
                } catch (e) { console.warn(`⚠️  Overwrite malformed ${key}`); }
            }

            // Append & De-dupe
            const existingIds = new Set(dayData.events.map(e => e.id));
            events.forEach(e => {
                if (!existingIds.has(e.id)) {
                    dayData.events.push(e);
                    existingIds.add(e.id);
                }
            });

            dayData.last_updated = new Date().toISOString();
            await uploadToS3(key, JSON.stringify(dayData, null, 2), "application/json");
        }

        console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log(`  ✅ PIPELINE COMPLETE | New Events Processed: ${newEvents.length}`);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { runScraper };
