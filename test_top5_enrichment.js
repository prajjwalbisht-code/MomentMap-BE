const fs = require("fs");
const path = require("path");
const { enrichTraktMovie } = require("./src/services/aiService");

async function testTop5() {
    const traktFile = path.join(__dirname, "trakt_genz_upcoming.json");
    if (!fs.existsSync(traktFile)) {
        console.error("❌ trakt_genz_upcoming.json not found. Run the pipeline first.");
        return;
    }

    const traktData = JSON.parse(fs.readFileSync(traktFile, "utf-8"));
    const top5 = traktData.items.slice(0, 5);

    console.log(`🚀 Enriching Top 5 Movies from Trakt...\n`);

    for (let i = 0; i < top5.length; i++) {
        const movie = top5[i];
        console.log(`[${i + 1}/5] Processing: ${movie.title} (${movie.year})...`);

        try {
            const start = Date.now();
            const enriched = await enrichTraktMovie(movie);
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);

            console.log(`   ✅ Enriched in ${elapsed}s`);
            console.log(`   🎨 Fashion reasoning: ${enriched.fashion_keywords?.reasoning?.substring(0, 100)}...`);
            console.log(`   📣 Marketing App Headline: ${enriched.marketing?.app?.headline}`);
            console.log(`   📣 Social Media Headline: ${enriched.marketing?.social_media?.headline}`);
            console.log(`   📣 : ${enriched}`);
            console.log("------------------------------------------");
        } catch (err) {
            console.error(`   ❌ Failed: ${err.message}`);
        }
    }

    console.log("\n✅ Manual check complete.");
}

testTop5();
