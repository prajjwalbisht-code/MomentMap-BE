"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { getObjectFromS3 } = require("./s3Service");

let cachedProducts = null;

/**
 * Loads the product catalog from TSV (S3 or local).
 * @returns {Promise<Array>}
 */
async function loadProductCatalog() {
    if (cachedProducts) return cachedProducts;

    const catalogPath = config.pipeline.productCatalogPath;
    let content = "";

    try {
        if (catalogPath.startsWith("s3://")) {
            const key = catalogPath.replace(/^s3:\/\/[^\/]+\//, "");
            content = await getObjectFromS3(key);
        } else {
            const fullPath = path.isAbsolute(catalogPath) ? catalogPath : path.join(process.cwd(), catalogPath);
            if (fs.existsSync(fullPath)) {
                content = fs.readFileSync(fullPath, "utf-8");
            } else {
                console.warn(`⚠️  Product catalog not found at ${fullPath}. Using empty catalog.`);
                return [];
            }
        }

        if (!content) return [];

        const lines = content.trim().split("\n");
        const headers = lines[0].split("\t").map(h => h.trim());

        cachedProducts = lines.slice(1).map(line => {
            const cols = line.split("\t");
            const obj = {};
            headers.forEach((h, i) => {
                obj[h] = cols[i] ? cols[i].trim() : "";
            });
            return obj;
        });

        console.log(`📦 Loaded ${cachedProducts.length} products from catalog.`);
        return cachedProducts;
    } catch (err) {
        console.error("❌ Failed to load product catalog:", err.message);
        return [];
    }
}

/**
 * Matches an event against the product catalog and returns top style_codes.
 * @param {Object} event - Enriched event with fashion_keywords
 * @returns {Promise<Array>} - List of style_code strings
 */
async function matchProducts(event) {
    const products = await loadProductCatalog();
    if (!products.length) return [];

    const kw = event.fashion_keywords;
    if (!kw) return [];

    const department = (kw.department || []).map(d => d.toLowerCase());
    const preferred = (kw.preferred_categories || []).map(c => c.toLowerCase());
    const avoid = (kw.avoid_categories || []).map(c => c.toLowerCase());

    const scored = products.filter(p => {
        // Hard filters
        const pGender = (p.gender || "").toLowerCase();
        const pCat = (p.category || "").toLowerCase();

        // 1. Gender check
        if (department.length > 0 && pGender && !department.includes(pGender) && pGender !== "unisex") {
            return false;
        }

        // 2. Category check
        if (preferred.length > 0 && !preferred.includes(pCat)) {
            return false;
        }
        if (avoid.includes(pCat)) {
            return false;
        }

        return true;
    }).map(p => {
        let score = 0;

        // Soft scoring
        const fieldsToMatch = ["color", "fit", "style", "pattern", "material", "neckline", "occasion", "detail", "transparency"];

        for (const field of fieldsToMatch) {
            const pVal = (p[field] || "").toLowerCase();
            const kwVals = (kw[field] || []).map(v => v.toLowerCase());

            if (pVal && kwVals.includes(pVal)) {
                score++;
            }
        }

        return { style_code: p.style_code, score };
    });

    // Sort by score descending and take top N
    const topProducts = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, config.pipeline.topNProducts)
        .map(p => p.style_code);

    return topProducts;
}

module.exports = { loadProductCatalog, matchProducts };
