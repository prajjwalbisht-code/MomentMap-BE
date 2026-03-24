"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { getObjectFromS3 } = require("./s3Service");

let cachedProducts = null;
const MATCHING_RULES = config.matching || {};
const FIELD_WEIGHTS = MATCHING_RULES.fieldWeights || {};
const ACTIVITY_PENALTIES = MATCHING_RULES.activityPenalties || {};
const OCCASION_PENALTIES = MATCHING_RULES.occasionPenalties || {};
const SEMANTIC_GROUPS = MATCHING_RULES.semanticGroups || {};
const TOKEN_CANONICAL_MAP = MATCHING_RULES.tokenCanonicalMap || {};
const CATEGORY_FAMILIES = MATCHING_RULES.categoryFamilies || {};
const SEMANTIC_SCORE_MULTIPLIER = MATCHING_RULES.semanticScoreMultiplier || 0.4;
const BASE_INCLUSION_THRESHOLD = MATCHING_RULES.inclusionThreshold || 12;
const FALLBACK_THRESHOLD_DELTA = MATCHING_RULES.fallbackThresholdDelta || 2;
const FALLBACK_MIN_CANDIDATES = MATCHING_RULES.fallbackMinCandidates || 6;

// ─────────────────────────────────────────────
// LOAD PRODUCT CATALOG
// ─────────────────────────────────────────────
async function loadProductCatalog() {
    if (cachedProducts) return cachedProducts;

    const catalogPath = config.pipeline.productCatalogPath;
    let content = "";
    let isJson = catalogPath.endsWith(".json");

    try {
        if (catalogPath.startsWith("s3://")) {
            const key = catalogPath.replace(/^s3:\/\/[^\/]+\//, "");
            content = await getObjectFromS3(key);
            isJson = key.endsWith(".json");
        } else {
            const fullPath = path.isAbsolute(catalogPath)
                ? catalogPath
                : path.join(process.cwd(), catalogPath);

            if (fs.existsSync(fullPath)) {
                content = fs.readFileSync(fullPath, "utf-8");
            } else {
                console.warn(`⚠️  Product catalog not found at ${fullPath}. Using empty catalog.`);
                return [];
            }
        }

        if (!content) return [];

        let rawProducts = [];
        if (isJson) {
            rawProducts = JSON.parse(content);
        } else {
            const lines = content.trim().split("\n");
            const headers = lines[0].split("\t").map(h => h.trim());
            rawProducts = lines.slice(1).map(line => {
                const cols = line.split("\t");
                const obj = {};
                headers.forEach((h, i) => {
                    obj[h] = cols[i] ? cols[i].trim() : "";
                });
                return obj;
            });
        }

        // Normalize all keys (e.g. "Style Code" -> "style_code")
        cachedProducts = rawProducts.map(p => {
            const normalized = {};
            for (const [key, val] of Object.entries(p)) {
                const cleanKey = key.trim().toLowerCase().replace(/\s+/g, "_");
                normalized[cleanKey] = val;
            }
            // Ensure compatibility mappings
            if (normalized.department && !normalized.gender) normalized.gender = normalized.department;
            if (normalized.gender && !normalized.department) normalized.department = normalized.gender;
            return normalized;
        });

        console.log(`📦 Loaded ${cachedProducts.length} products (normalized). Source: ${isJson ? "JSON" : "TSV"}`);
        return cachedProducts;

    } catch (err) {
        console.error("❌ Failed to load product catalog:", err.message);
        return [];
    }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * FIX: Treats "0" and "n/a" as null sentinels — returns [] for these.
 * Splits on comma/pipe/semicolon, lowercases, and trims.
 */
function parseProductValues(raw) {
    if (!raw && raw !== 0) return [];
    const str = Array.isArray(raw) ? raw.join(",") : String(raw).trim();
    // Treat placeholder values as empty
    if (str === "0" || str.toLowerCase() === "n/a" || str === "" || str === "-") return [];
    return str
        .toLowerCase()
        .split(/[,|;]+/)
        .map(v => normalizeToken(v))
        .filter(v => v && v !== "0" && v !== "n/a");
}

/**
 * Normalizes event keyword values to lowercase array.
 */
function parseEventValues(val) {
    if (!val || val === "not-needed") return [];
    if (Array.isArray(val)) return val.map(v => normalizeToken(v)).filter(Boolean);
    if (typeof val === "string") return [normalizeToken(val)];
    return [];
}

function normalizeToken(value) {
    if (value === null || value === undefined) return "";
    const raw = String(value).trim().toLowerCase();
    if (!raw) return "";

    const compact = raw.replace(/[_/\s]+/g, "-");
    const alnum = compact.replace(/[^a-z0-9-]/g, "");

    return TOKEN_CANONICAL_MAP[alnum] || TOKEN_CANONICAL_MAP[compact] || compact;
}

function tokenizeCategory(value) {
    const normalized = normalizeToken(value);
    if (!normalized) return [];
    return normalized
        .split(/[-,|;]+/)
        .map(v => v.trim())
        .filter(Boolean);
}

function categoryToFamilies(category) {
    const normalized = normalizeToken(category);
    const tokens = new Set(tokenizeCategory(category));
    if (normalized) tokens.add(normalized);
    const families = new Set();

    for (const [family, aliases] of Object.entries(CATEGORY_FAMILIES)) {
        if (!Array.isArray(aliases)) continue;
        if (aliases.some(alias => {
            const cleanAlias = normalizeToken(alias);
            return normalized.includes(cleanAlias) || tokens.has(cleanAlias);
        })) {
            families.add(family);
        }
    }

    return families;
}

function categoriesEquivalent(a, b) {
    const aNorm = normalizeToken(a);
    const bNorm = normalizeToken(b);
    if (!aNorm || !bNorm) return false;
    if (aNorm === bNorm || aNorm.includes(bNorm) || bNorm.includes(aNorm)) return true;

    const aFamilies = categoryToFamilies(a);
    const bFamilies = categoryToFamilies(b);
    if (aFamilies.size && bFamilies.size) {
        for (const f of aFamilies) {
            if (bFamilies.has(f)) return true;
        }
    }
    return false;
}

function getAdaptiveThreshold(kw) {
    const adaptive = MATCHING_RULES.adaptiveThreshold || {};
    if (!adaptive.enabled) return BASE_INCLUSION_THRESHOLD;

    const departments = parseEventValues(kw.department);
    const preferred = Array.isArray(kw.preferred_categories) ? kw.preferred_categories : [];
    const isBroadEvent = preferred.length >= (adaptive.broadEventPreferredCategoryCount || 10) &&
        departments.length >= (adaptive.broadDepartmentCount || 3);

    if (!isBroadEvent) return BASE_INCLUSION_THRESHOLD;
    return Math.max(8, BASE_INCLUSION_THRESHOLD + (adaptive.broadEventDelta || -1));
}

/**
 * Finds semantic group index for a given value in a field.
 */
function getSemanticGroupIndex(field, value) {
    const groups = SEMANTIC_GROUPS[field];
    if (!groups) return -1;
    return groups.findIndex(group => group.includes(value));
}

/**
 * Checks if two values are semantically related (same group).
 */
function areSemanticallyRelated(field, valA, valB) {
    const groupA = getSemanticGroupIndex(field, valA);
    if (groupA === -1) return false;
    return groupA === getSemanticGroupIndex(field, valB);
}

/**
 * Scores a single field match between product values and event keyword values.
 *   weight × 1.0  → exact match
 *   weight × 0.4  → semantic/synonym match
 *   0             → no match
 */
function scoreField(field, productValues, eventValues, weight) {
    if (!productValues.length || !eventValues.length) return 0;

    let bestScore = 0;

    for (const pVal of productValues) {
        for (const eVal of eventValues) {
            if (pVal === eVal) {
                bestScore = Math.max(bestScore, weight * 1.0);
            } else if (areSemanticallyRelated(field, pVal, eVal)) {
                bestScore = Math.max(bestScore, weight * SEMANTIC_SCORE_MULTIPLIER);
            }
        }
    }

    return bestScore;
}

// ─────────────────────────────────────────────
// HARD FILTER
// Returns false if product should be excluded
// ─────────────────────────────────────────────
function passesHardFilters(product, kw, options = {}) {
    const { relaxPreferred = false } = options;
    const department = parseEventValues(kw.department);
    const preferred = (kw.preferred_categories || []).map(c => normalizeToken(c));
    const avoid = (kw.avoid_categories || []).map(c => normalizeToken(c));

    const pGender = normalizeToken(product.gender || "");
    const pCat = normalizeToken(product.category || "");

    // 1. Gender/department filter
    if (
        department.length > 0 &&
        pGender &&
        !department.includes(pGender) &&
        pGender !== "unisex"
    ) {
        return false;
    }

    // 2. Must be in preferred categories
    if (!relaxPreferred && preferred.length > 0 && pCat && !preferred.some(c => categoriesEquivalent(pCat, c))) {
        return false;
    }

    // 3. Must not be in avoid categories
    if (avoid.some(c => categoriesEquivalent(pCat, c))) {
        return false;
    }

    return true;
}

// ─────────────────────────────────────────────
// PENALTY SCORING
// Subtracts points for mismatched activity/occasion
// that contradict the event's vibe.
// Only penalizes when the product value is NOT
// present in the event's keyword list at all.
// ─────────────────────────────────────────────
function getPenaltyScore(product, kw) {
    let penalty = 0;

    const eventActivities = parseEventValues(kw.activity);
    const eventOccasions = parseEventValues(kw.occasion);

    // Activity mismatch penalty
    const productActivities = parseProductValues(product.activity);
    for (const pAct of productActivities) {
        const isInEvent = eventActivities.includes(pAct) ||
            eventActivities.some(eAct => areSemanticallyRelated("activity", pAct, eAct));
        if (!isInEvent && ACTIVITY_PENALTIES[pAct] !== undefined) {
            penalty += ACTIVITY_PENALTIES[pAct];
        }
    }

    // Occasion mismatch penalty for very casual products in elevated events
    const productOccasions = parseProductValues(product.occasion);
    for (const pOcc of productOccasions) {
        const isInEvent = eventOccasions.includes(pOcc) ||
            eventOccasions.some(eOcc => areSemanticallyRelated("occasion", pOcc, eOcc));
        if (!isInEvent && OCCASION_PENALTIES[pOcc] !== undefined) {
            penalty += OCCASION_PENALTIES[pOcc];
        }
    }

    return penalty; // always negative or 0
}

// ─────────────────────────────────────────────
// BONUS SCORES
// ─────────────────────────────────────────────
function getBonusScore(product, kw) {
    let bonus = 0;

    const pCat = normalizeToken(product.category || "");
    const ethnicity = parseEventValues(kw.ethnicity);
    const preferredCats = (kw.preferred_categories || []).map(c => normalizeToken(c));

    // Ethnicity alignment bonus
    if (ethnicity.includes("ethnic")) {
        const ethnicCategories = ["saree", "kurta", "kurti", "lehenga", "ethnic", "salwar", "dhoti", "sherwani", "anarkali", "sharara", "chaniya"];
        if (ethnicCategories.some(e => pCat.includes(e))) bonus += 3;
    }

    if (ethnicity.includes("western") && !ethnicity.includes("ethnic")) {
        const westernCategories = ["t-shirt", "shirt", "top", "dress", "jeans", "trouser", "shorts", "skirt", "jumpsuit", "co-ord", "sweatshirt", "jacket", "sets", "other sets"];
        if (westernCategories.some(w => pCat.includes(w))) bonus += 2;
    }

    // Exact preferred category match
    if (preferredCats.some(c => categoriesEquivalent(c, pCat))) bonus += 2;

    // Jewellery bonus
    const jewelleryPattern = parseEventValues(kw.jewellery_pattern);
    const pendantsType = parseEventValues(kw.pendants_type);
    const jewelleryCategories = ["necklace", "earring", "bracelet", "ring", "anklet", "jewellery"];

    if (jewelleryCategories.some(j => pCat.includes(j))) {
        const pJewelleryPattern = parseProductValues([
            product.jewellery_pattern,
            product.pattern,
            product.pattern_2,
            product.pattern_3,
        ].filter(Boolean).join(","));
        const pPendantType = parseProductValues(product.pendant_type || product.pendants_type);

        if (jewelleryPattern.length && pJewelleryPattern.length) {
            bonus += scoreField("pattern", pJewelleryPattern, jewelleryPattern, 2);
        }
        if (pendantsType.length && pPendantType.length) {
            bonus += scoreField("pattern", pPendantType, pendantsType, 2);
        }
    }

    // Surface styling bonus
    const surfaceStyling = parseEventValues(kw.surface_styling);
    const pSurface = parseProductValues(product.surface_styling || product.fabric_finish);
    if (surfaceStyling.length && pSurface.length) {
        bonus += scoreField("pattern", pSurface, surfaceStyling, 2);
    }

    // Treatment / distress bonus
    const treatment = parseEventValues(kw.treatment);
    const distress = parseEventValues(kw.distress);
    const pTreatment = parseProductValues(product.treatment || product.wash);
    const pDistress = parseProductValues(product.distress);

    if (treatment.length && pTreatment.length) bonus += scoreField("pattern", pTreatment, treatment, 1);
    if (distress.length && pDistress.length) bonus += scoreField("pattern", pDistress, distress, 1);

    // Accent color (color_2) bonus
    const color2 = parseEventValues(kw.color_2);
    const pColor2 = parseProductValues(product.color_2 || product.accent_color);
    if (color2.length && pColor2.length) bonus += scoreField("color", pColor2, color2, 2);

    return bonus;
}

// ─────────────────────────────────────────────
// MAIN MATCH FUNCTION
// ─────────────────────────────────────────────
async function matchProductsDetailed(event) {
    const products = await loadProductCatalog();
    if (!products.length) return [];

    const kw = event.fashion_keywords;
    if (!kw) return [];

    const threshold = getAdaptiveThreshold(kw);
    const telemetry = {
        event_id: event.id,
        event_title: event.title,
        total_products: products.length,
        hard_filtered_out: 0,
        below_threshold: 0,
        fallback_triggered: false,
        fallback_added: 0,
    };

    const scoreProduct = (product, thresholdToUse) => {
        const breakdown = { fields: {}, bonus: 0, penalty: 0, threshold: thresholdToUse };
        let score = 0;

        for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
            const productValues = parseProductValues(product[field]);
            const eventValues = parseEventValues(kw[field]);
            const fieldScore = scoreField(field, productValues, eventValues, weight);
            score += fieldScore;
            if (fieldScore > 0) breakdown.fields[field] = Math.round(fieldScore * 100) / 100;
        }

        breakdown.bonus = Math.round(getBonusScore(product, kw) * 100) / 100;
        breakdown.penalty = Math.round(getPenaltyScore(product, kw) * 100) / 100;
        score += breakdown.bonus + breakdown.penalty;

        return {
            ...product,
            style_code: product.style_code,
            score: Math.round(score * 100) / 100,
            category: product.category,
            gender: product.gender,
            breakdown,
        };
    };

    const runMatchingPass = (passThreshold, options = {}) => {
        const localScored = [];
        for (const product of products) {
            if (!passesHardFilters(product, kw, options)) {
                if (!options.relaxPreferred) telemetry.hard_filtered_out += 1;
                continue;
            }
            const result = scoreProduct(product, passThreshold);
            if (result.score < passThreshold) {
                if (!options.relaxPreferred) telemetry.below_threshold += 1;
                continue;
            }
            localScored.push(result);
        }
        return localScored;
    };

    const scored = runMatchingPass(threshold);

    if (scored.length < FALLBACK_MIN_CANDIDATES) {
        telemetry.fallback_triggered = true;
        const fallbackThreshold = Math.max(8, threshold - FALLBACK_THRESHOLD_DELTA);
        const fallbackScored = runMatchingPass(fallbackThreshold, { relaxPreferred: true });
        const existingCodes = new Set(scored.map(s => s.style_code));
        for (const item of fallbackScored) {
            if (!existingCodes.has(item.style_code)) {
                scored.push(item);
                telemetry.fallback_added += 1;
            }
        }
    }

    // Step 6: Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Step 7: Optional debug logging
    if (config.pipeline.debugScoring) {
        console.log(`\n🎯 Top matches for "${event.title}" (threshold: ${threshold}):`);
        scored.slice(0, 10).forEach((p, i) => {
            console.log(`  ${i + 1}. ${p.style_code} | ${p.category} | ${p.gender} | score: ${p.score}`);
            if (config.pipeline.debugScoring === "verbose" || config.pipeline.debugScoring === true) {
                console.log(`     breakdown: ${JSON.stringify(p.breakdown)}`);
            }
        });
    }

    if (config.pipeline.enableMatchingTelemetry) {
        const scoredTop = scored.slice(0, config.pipeline.topNProducts);
        const scoreBuckets = { gte20: 0, gte16: 0, gte12: 0, lt12: 0 };
        const categorySpread = new Set();

        for (const row of scoredTop) {
            categorySpread.add(normalizeToken(row.category));
            if (row.score >= 20) scoreBuckets.gte20 += 1;
            else if (row.score >= 16) scoreBuckets.gte16 += 1;
            else if (row.score >= 12) scoreBuckets.gte12 += 1;
            else scoreBuckets.lt12 += 1;
        }

        console.log(`[matching_telemetry] ${JSON.stringify({
            ...telemetry,
            threshold,
            final_candidates: scored.length,
            score_buckets: scoreBuckets,
            top_category_diversity: categorySpread.size,
        })}`);
    }

    // Step 8: Return top N style codes
    return scored.slice(0, config.pipeline.topNProducts);
}

async function matchProducts(event) {
    const detailed = await matchProductsDetailed(event);
    return detailed.map(p => p.style_code);
}

async function matchProductObjects(event) {
    const detailed = await matchProductsDetailed(event);
    return detailed.map(({ breakdown, ...product }) => ({
        "Style Code": product.style_code || "",
        Category: product.category || "",
        "Product Name": product.product_name || "",
        Brand: product.brand || "",
        "Image URL 1": product.image_url_1 || "",
        gender: product.gender || "",
    }));
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
    loadProductCatalog,
    matchProducts,
    matchProductObjects,
    __private: {
        parseProductValues,
        parseEventValues,
        scoreField,
        getPenaltyScore,
        getBonusScore,
        passesHardFilters,
        normalizeToken,
        categoriesEquivalent,
        categoryToFamilies,
        getAdaptiveThreshold,
        matchProductsDetailed,
    },
};