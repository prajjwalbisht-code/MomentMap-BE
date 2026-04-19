"use strict";

const path = require("path");
const fs = require("fs");
const { runProductMatcherFromProducts } = require("../productMatcher");

async function main() {
    console.log("🚀 Starting verification and catalog fix...");

    // We'll run it with an empty array to trigger a refresh of the existing catalog 
    // and re-match against the full static catalog now that we've fixed the code.
    try {
        const result = await runProductMatcherFromProducts([], false);
        console.log("\n✅ Verification and update complete!");
        console.log(`📊 Events matched: ${result.events_in_s3}`);
        console.log(`📊 New links added: ${result.new_links_added}`);
        console.log(`📊 Events updated: ${result.events_with_new_products}`);

        // Final sanity check of the local output
        const matches = JSON.parse(fs.readFileSync(path.join(__dirname, "../product_event_matches.json"), "utf-8"));
        console.log(`\n🔍 Found ${Object.keys(matches.matches).length} events with matches in output.`);

    } catch (err) {
        console.error("❌ verification failed:", err);
        process.exit(1);
    }
}

main();
