"use strict";

/**
 * productMatcher.js
 *
 * Standalone pipeline:
 *   1. Parse Excel (.xlsx) → products JSON
 *   2. Load all YYYY-MM/DD.json day files from S3
 *   3. Score every product against every event (using unified productService)
 *   4. MERGE matched style_codes into event.products (de-duped, never removes)
 *   5. Re-upload updated day files to S3
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { uploadToS3, listObjectsInS3, getObjectFromS3 } = require("./src/services/s3Service");
const config = require("./src/config");
const { loadProductCatalog, matchProducts, matchProductObjects, setCachedProducts } = require("./src/services/productService");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const LOCAL_OUTPUT_FILE = path.join(__dirname, "product_event_matches.json");

// ─── STEP 1: PARSE EXCEL ──────────────────────────────────────────────────────

/**
 * Parses an .xlsx source into cleaned product objects.
 */
function parseExcel(filePathOrBuffer, fileName = "upload") {
  let buffer;
  let label;

  if (typeof filePathOrBuffer === "string") {
    if (!fs.existsSync(filePathOrBuffer)) {
      throw new Error(`Excel file not found: ${filePathOrBuffer}`);
    }
    buffer = fs.readFileSync(filePathOrBuffer);
    label = path.basename(filePathOrBuffer);
  } else {
    buffer = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : Buffer.from(filePathOrBuffer);
    label = fileName;
  }

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet);

  const products = rawRows.map((row) => {
    const cleaned = {};
    for (const [key, val] of Object.entries(row)) {
      const cleanKey = key.trim().toLowerCase().replace(/\s+/g, "_");
      cleaned[cleanKey] = val !== undefined && val !== null ? String(val).trim() : null;
    }
    return cleaned;
  });

  console.log(`📦 Parsed ${products.length} products from ${label}`);
  return products;
}

// ─── STEP 2: LOAD DAY FILES FROM S3 ──────────────────────────────────────────

async function loadAllMonthlyFilesFromS3() {
  const monthFilePattern = /^events\/\d{4}-\d{2}\.json$/;
  const allObjects = await listObjectsInS3("events/");
  const monthKeys = (allObjects || [])
    .map((o) => o.Key)
    .filter((k) => monthFilePattern.test(k));

  if (monthKeys.length === 0) {
    console.warn("⚠️  No events/YYYY-MM.json files found in S3.");
    return new Map();
  }

  const monthFileMap = new Map();
  for (const key of monthKeys) {
    try {
      const content = await getObjectFromS3(key);
      if (!content) continue;
      monthFileMap.set(key, { data: JSON.parse(content), dirty: false });
    } catch (e) {
      console.warn(`   ⚠️  Skipped ${key}: ${e.message}`);
    }
  }
  return monthFileMap;
}

// ─── STEP 2.5: MANAGE PRODUCT CATALOG IN S3 ──────────────────────────────────

async function loadExistingCatalog() {
  const catalogPath = config.pipeline.productCatalogPath || "products/total_products.json";

  const key = catalogPath.startsWith("s3://") ? catalogPath.replace(/^s3:\/\/[^\/]+\//, "") : catalogPath;
  let keyToLoad = key;
  if (key.endsWith(".tsv")) {
    const jsonKey = key.replace(".tsv", ".json");
    const exists = await getObjectFromS3(jsonKey);
    if (exists) keyToLoad = jsonKey;
  }

  const s3Content = await getObjectFromS3(keyToLoad);
  let products = [];

  if (s3Content) {
    try {
      if (keyToLoad.endsWith(".json")) products = JSON.parse(s3Content);
      else if (keyToLoad.endsWith(".tsv")) {
        const lines = s3Content.trim().split("\n");
        const headers = lines[0].split("\t").map(h => h.trim());
        products = lines.slice(1).map(line => {
          const cols = line.split("\t");
          const obj = {};
          headers.forEach((h, i) => {
            const cleanKey = h.toLowerCase().replace(/\s+/g, "_");
            obj[cleanKey] = cols[i] ? cols[i].trim() : "";
          });
          return obj;
        });
      }
    } catch (e) {
      console.warn("⚠️  Error parsing S3 catalog, falling back to local static catalog.");
    }
  }

  // BOOTSTRAP/MERGE with local static catalog if it exists and S3 is small
  const staticPath = path.join(process.cwd(), "products_static.json");
  if (fs.existsSync(staticPath)) {
    try {
      const staticContent = fs.readFileSync(staticPath, "utf-8");
      const staticProducts = JSON.parse(staticContent);
      console.log(`📦 Loaded ${staticProducts.length} products from products_static.json`);

      const catalogMap = new Map();
      // Load static first
      staticProducts.forEach(p => {
        const normalized = {};
        for (const [k, v] of Object.entries(p)) {
          normalized[k.trim().toLowerCase().replace(/\s+/g, "_")] = v;
        }
        const code = normalized.style_code;
        if (code) catalogMap.set(String(code).toLowerCase(), normalized);
      });
      // Overlay S3 (S3 might have updates, but preserve essential fields if S3 is empty)
      products.forEach(p => {
        const normalized = {};
        for (const [k, v] of Object.entries(p)) {
          normalized[k.trim().toLowerCase().replace(/\s+/g, "_")] = v;
        }
        const code = normalized.style_code;
        if (code) {
          const lowerCode = String(code).toLowerCase();
          if (catalogMap.has(lowerCode)) {
            const existing = catalogMap.get(lowerCode);
            // Merge: S3 values win UNLESS they are empty and static has them
            const merged = { ...existing };
            for (const [k, v] of Object.entries(normalized)) {
              if (v !== null && v !== undefined && v !== "") {
                merged[k] = v;
              }
            }
            catalogMap.set(lowerCode, merged);
          } else {
            catalogMap.set(lowerCode, normalized);
          }
        }
      });

      products = Array.from(catalogMap.values());
      console.log(`📊 Unified catalog size: ${products.length} products.`);
    } catch (e) {
      console.warn(`⚠️  Failed to load static catalog: ${e.message}`);
    }
  }

  return products;
}

async function saveCatalogToS3(products) {
  let key = config.pipeline.productCatalogPath || "products/total_products.json";
  if (key.startsWith("s3://")) key = key.replace(/^s3:\/\/[^\/]+\//, "");
  if (key.endsWith(".tsv")) key = key.replace(".tsv", ".json");
  await uploadToS3(key, JSON.stringify(products, null, 2), "application/json");
}

// ─── STEP 3: MATCH + MERGE + UPLOAD ──────────────────────────────────────

async function matchAndMerge(products, monthFileMap, dryRun = false) {
  const allEvents = [];
  for (const [monthKey, { data }] of monthFileMap) {
    // data is { "DD": { "events": [...], "last_updated": "..." } }
    for (const [dayKey, dayObj] of Object.entries(data)) {
      for (const event of (dayObj.events || [])) {
        if (event.id) allEvents.push({ monthKey, dayKey, event });
      }
    }
  }

  const totalEvents = allEvents.length;
  const matchSummary = {};
  let totalMatches = 0;
  let eventsUpdated = 0;

  console.log(`\n🔗 Re-matching ${totalEvents} events using unified service logic...`);

  for (const { monthKey, dayKey, event } of allEvents) {
    const rawProducts = event.products || [];
    const normalizedProducts = [];
    const existingCodes = new Set();

    const catalog = await loadProductCatalog();
    const toDisplayObject = (p) => {
      // Use normalized keys for lookup
      const img = p.image_url_1 || p.image_url || p.imageurl || p.image || p.img || p["Image URL 1"] || "";
      const code = p.style_code || p.stylecode || p["Style Code"] || "";
      const name = p.product_name || p.productname || p.name || p["Product Name"] || "";
      const brand = p.brand || p["Brand"] || "";
      const cat = p.category || p["Category"] || "";
      const gen = p.gender || p.Gender || p.department || "";

      return {
        "Style Code": code,
        Category: cat,
        "Product Name": name,
        Brand: brand,
        "Image URL 1": img,
        gender: gen,
      };
    };

    // 1. Convert existing strings/objects to standardized objects
    for (const p of rawProducts) {
      let code = null;
      if (typeof p === "string") {
        code = p.toLowerCase();
      } else {
        const c = p.style_code || p["Style Code"] || p.styleCode;
        if (c) code = String(c).toLowerCase();
      }

      if (code && !existingCodes.has(code)) {
        if (typeof p === "string") {
          const catProduct = catalog.find(cp =>
            String(cp.style_code || cp["Style Code"] || cp.styleCode).toLowerCase() === code
          );
          if (catProduct) {
            normalizedProducts.push(toDisplayObject(catProduct));
          } else {
            normalizedProducts.push(p);
          }
        } else {
          normalizedProducts.push(toDisplayObject(p));
        }
        existingCodes.add(code);
      }
    }

    // 2. Add new matches from the current pipeline
    const newMatches = await matchProductObjects(event);
    const addedCodes = [];

    for (const match of newMatches) {
      const code = match.style_code || match["Style Code"] || match.styleCode;
      const normalizedCode = String(code).toLowerCase();
      if (!existingCodes.has(normalizedCode)) {
        normalizedProducts.push(match);
        existingCodes.add(normalizedCode);
        addedCodes.push(normalizedCode);
      }
    }

    // Force dirty if we converted objects or changed anything
    // (In this case, we want to fix the keys, so any change in product format should trigger dirty)
    const productsChanged = addedCodes.length > 0 ||
      normalizedProducts.length !== rawProducts.length ||
      JSON.stringify(normalizedProducts) !== JSON.stringify(rawProducts);

    if (productsChanged) {
      event.products = normalizedProducts;
      monthFileMap.get(monthKey).dirty = true;
      if (addedCodes.length > 0) {
        matchSummary[event.id] = addedCodes;
        totalMatches += addedCodes.length;
        eventsUpdated++;
      }
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    events_in_s3: totalEvents,
    new_links_added: totalMatches,
    events_with_new_products: eventsUpdated,
    matches: matchSummary,
  };

  if (!dryRun) {
    fs.writeFileSync(LOCAL_OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
    const dirtyFiles = [...monthFileMap.entries()].filter(([, v]) => v.dirty);
    for (const [monthKey, { data }] of dirtyFiles) {
      await uploadToS3(monthKey, JSON.stringify(data, null, 2), "application/json");
      console.log(`   ✅ Updated month file: ${monthKey}`);
    }
  }

  return output;
}

async function _run(newProducts, dryRun) {
  const existingCatalog = await loadExistingCatalog();
  const catalogMap = new Map();

  const ingest = (p) => {
    const normalized = {};
    for (const [k, v] of Object.entries(p)) {
      normalized[k.trim().toLowerCase().replace(/\s+/g, "_")] = v;
    }

    // Canonical mapping for essential fields if missing
    if (!normalized.style_code && normalized.stylecode) normalized.style_code = normalized.stylecode;
    if (!normalized.image_url_1) {
      normalized.image_url_1 = normalized.imageurl || normalized.image || normalized.img || normalized.image_url || "";
    }
    if (!normalized.product_name && normalized.productname) normalized.product_name = normalized.productname;
    if (!normalized.product_name && normalized.name) normalized.product_name = normalized.name;

    const code = normalized.style_code;
    if (code) catalogMap.set(String(code).toLowerCase(), normalized);
  };

  existingCatalog.forEach(ingest);
  newProducts.forEach(ingest);

  const updatedCatalog = Array.from(catalogMap.values());
  if (!dryRun) await saveCatalogToS3(updatedCatalog);

  // Sync with productService for matching
  setCachedProducts(updatedCatalog);

  const monthFileMap = await loadAllMonthlyFilesFromS3();
  return matchAndMerge(updatedCatalog, monthFileMap, dryRun);
}

async function runProductMatcher(excelFilePath, dryRun = false) {
  const products = parseExcel(excelFilePath);
  return _run(products, dryRun);
}

async function runProductMatcherFromBuffer(buffer, fileName = "upload.xlsx", dryRun = false) {
  const products = parseExcel(buffer, fileName);
  return _run(products, dryRun);
}

async function runProductMatcherFromProducts(productsArray, dryRun = false) {
  if (!Array.isArray(productsArray)) {
    throw new Error("productsArray must be an array");
  }
  return _run(productsArray, dryRun);
}

/**
 * purgeProductFromEvents
 * Removes products from all monthly event files in S3 by style code.
 * @param {string[]} styleCodes - Array of style codes to remove.
 */
async function purgeProductFromEvents(styleCodes) {
  if (!Array.isArray(styleCodes) || styleCodes.length === 0) return;
  const codesToPurge = new Set(styleCodes.map(c => String(c).toLowerCase()));

  console.log(`\n🧹 [Purge] Starting purge of ${codesToPurge.size} products from all S3 events...`);

  const monthFileMap = await loadAllMonthlyFilesFromS3();
  let totalRemoved = 0;
  let filesUpdated = 0;

  for (const [monthKey, { data }] of monthFileMap) {
    let fileDirty = false;
    for (const event of data) {
      if (!event.products || !Array.isArray(event.products)) continue;

      const initialCount = event.products.length;
      event.products = event.products.filter(p => {
        const code = p.style_code || p.styleCode || p["Style Code"];
        return !codesToPurge.has(String(code).toLowerCase());
      });

      if (event.products.length !== initialCount) {
        totalRemoved += (initialCount - event.products.length);
        fileDirty = true;
      }
    }

    if (fileDirty) {
      await uploadToS3(monthKey, JSON.stringify(data, null, 2), "application/json");
      console.log(`   ✅ Purged and updated: ${monthKey}`);
      filesUpdated++;
    }
  }

  console.log(`✨ [Purge] Complete. Removed ${totalRemoved} product links across ${filesUpdated} files.`);
  return { totalRemoved, filesUpdated };
}

module.exports = {
  runProductMatcher,
  runProductMatcherFromBuffer,
  parseExcel,
  runProductMatcherFromProducts,
  loadExistingCatalog,
  saveCatalogToS3,
  purgeProductFromEvents,
};
