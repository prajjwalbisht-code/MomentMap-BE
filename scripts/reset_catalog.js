"use strict";

const fs = require("fs");
const path = require("path");
const { uploadToS3 } = require("../src/services/s3Service");
const config = require("../src/config");

async function main() {
    console.log("🚀 Starting S3 Catalog Reset...");

    const staticPath = path.join(process.cwd(), "products_static.json");
    if (!fs.existsSync(staticPath)) {
        console.error("❌ products_static.json not found!");
        process.exit(1);
    }

    try {
        const rawContent = fs.readFileSync(staticPath, "utf-8");
        const products = JSON.parse(rawContent);
        console.log(`📦 Read ${products.length} products from products_static.json`);

        // We'll normalize them to ensure naming consistency (style_code etc)
        const normalizedProducts = products.map(p => {
            const normalized = {};
            for (const [k, v] of Object.entries(p)) {
                normalized[k.trim().toLowerCase().replace(/\s+/g, "_")] = v;
            }
            // Ensure style_code exists
            if (!normalized.style_code && normalized.stylecode) normalized.style_code = normalized.stylecode;
            if (!normalized.style_code && normalized["style code"]) normalized.style_code = normalized["style code"];
            return normalized;
        });

        console.log("📤 Uploading clean catalog to S3...");
        const s3Key = "products/total_products.json";
        await uploadToS3(s3Key, JSON.stringify(normalizedProducts, null, 2), "application/json");

        console.log(`✅ Success! S3 catalog reset to ${normalizedProducts.length} master products.`);
    } catch (err) {
        console.error("❌ Reset failed:", err);
        process.exit(1);
    }
}

main();
