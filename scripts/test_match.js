"use strict";

const { loadProductCatalog, matchProductsDetailed, setCachedProducts } = require("./src/services/productService");
const { getObjectFromS3 } = require("./src/services/s3Service");

async function debug() {
    console.log("🔍 Debugging Product Matching...");
    const catalog = await loadProductCatalog();
    console.log(`📊 Catalog size: ${catalog.length}`);

    // Try a specific event (e.g. Makar Sankranti)
    const data = await getObjectFromS3("events/2026-01.json");
    const events = JSON.parse(data);
    const event = events["14"].events.find(e => e.id === "makar-sankranti_14_jan");

    console.log(`🎯 Event: ${event.title}`);
    console.log(`🏷️ Keywords: ${JSON.stringify(event.fashion_keywords, null, 2)}`);

    const matches = await matchProductsDetailed(event);
    console.log(`\n✅ Matches found: ${matches.length}`);

    if (matches.length > 0) {
        console.log("Top matches:");
        matches.slice(0, 5).forEach(m => {
            console.log(`- ${m.style_code} | score: ${m.score} | breakdown: ${JSON.stringify(m.breakdown)}`);
        });
    } else {
        console.log("❌ NO MATCHES FOUND. Checking why...");
        // Check one product manually
        const p = catalog[0];
        console.log(`\nProduct Sample: ${JSON.stringify(p, null, 2)}`);
    }
}

debug();
