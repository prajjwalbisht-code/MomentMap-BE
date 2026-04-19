"use strict";

const { loadProductCatalog, setCachedProducts, clearCache } = require("../src/services/productService");

async function test() {
    console.log("🚀 Starting refresh verification test...");

    // 1. Set cache manually
    console.log("1. Setting cache manually...");
    setCachedProducts([{ style_code: "MANUAL", name: "Manual Product" }]);

    // 2. Load (should return manual)
    console.log("2. Loading (should use cache)...");
    let products = await loadProductCatalog();
    console.log("   First product style code:", products[0]?.style_code);

    // 3. Clear cache
    console.log("3. Clearing cache...");
    clearCache();

    // 4. Load (should reload from source, e.g. S3 fallback)
    console.log("4. Loading (should reload from source)...");
    products = await loadProductCatalog();
    console.log("   Catalog size after reload:", products.length);

    // 5. Force refresh
    console.log("5. Force refreshing...");
    products = await loadProductCatalog(true);
    console.log("   Catalog size after force refresh:", products.length);

    console.log("\n✅ Refresh verification completed!");
}

test();
