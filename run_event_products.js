"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { writeEventWithMatchedProducts, attachMatchedProductsToEvent } = require("./src/services/eventProductsService");

function parseInputContent(raw) {
    try {
        return JSON.parse(raw);
    } catch (_) {
        // Supports files like: export const STATIC_EVENTS = [ ... ];
        const cleaned = raw
            .replace(/^\s*export\s+const\s+\w+\s*=\s*/m, "")
            .replace(/;\s*$/, "")
            .trim();
        return vm.runInNewContext(`(${cleaned})`);
    }
}

async function run() {
    const inputArg = process.argv[2];
    const outputArg = process.argv[3] || "events_with_products.json";

    if (!inputArg) {
        console.error("Usage: node run_event_products.js <eventInput.json> [output.json]");
        process.exit(1);
    }

    const inputPath = path.isAbsolute(inputArg)
        ? inputArg
        : path.join(process.cwd(), inputArg);

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const parsed = parseInputContent(fs.readFileSync(inputPath, "utf-8"));

    if (Array.isArray(parsed)) {
        const enrichedEvents = [];
        for (let i = 0; i < parsed.length; i++) {
            const event = parsed[i];
            const enriched = await attachMatchedProductsToEvent(event);
            enrichedEvents.push(enriched);
            process.stdout.write(`\rProcessed ${i + 1}/${parsed.length} events`);
        }
        process.stdout.write("\n");

        const fullOutputPath = path.isAbsolute(outputArg)
            ? outputArg
            : path.join(process.cwd(), outputArg);
        fs.writeFileSync(fullOutputPath, JSON.stringify(enrichedEvents, null, 2), "utf-8");
        console.log(`Wrote ${enrichedEvents.length} enriched events to ${fullOutputPath}`);
        return;
    }

    const { outputPath, event } = await writeEventWithMatchedProducts(parsed, outputArg);
    console.log(`Wrote event with ${event.products.length} matched products to ${outputPath}`);
}

run().catch(err => {
    console.error("Failed to build event products:", err.message);
    process.exit(1);
});
