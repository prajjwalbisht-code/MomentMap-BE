"use strict";

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { getObjectFromS3 } = require("../services/s3Service");
const { runProductMatcherFromBuffer, runProductMatcherFromProducts } = require("../../productMatcher");

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

/**
 * GET /api/products
 * Returns the total product catalog JSON from S3.
 */
router.get("/", async (req, res) => {
    try {
        const s3Key = "products/total_products.json";
        console.log(`📂 [ProductsAPI] Fetching ${s3Key} from S3...`);

        const data = await getObjectFromS3(s3Key);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Product catalog not found in S3."
            });
        }

        const products = JSON.parse(data);
        return res.json({
            success: true,
            count: Array.isArray(products) ? products.length : 1,
            data: products
        });
    } catch (err) {
        console.error("❌ [ProductsAPI] Error fetching catalog:", err.message);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch product catalog from S3.",
            error: err.message
        });
    }
});

/**
 * POST /api/products
 * Accepts an .xlsx file OR a JSON product object.
 * Parses it, matches products to events, 
 * updates S3 event files, and returns a summary.
 */
router.post("/", upload.single("file"), async (req, res) => {
    console.log(`📥 [ProductsAPI] Incoming POST request. Content-Length: ${req.headers['content-length']}`);
    try {
        const dryRun = req.query.dry_run === "true";
        let summary;

        if (req.file) {
            // ─── 1. FILE UPLOAD (.xlsx) ───
            const fileName = req.file.originalname || "upload.xlsx";
            const buffer = req.file.buffer;
            console.log(`\n📤 [ProductsAPI] POST /api/products — File: ${fileName} (${buffer.length} bytes)${dryRun ? " [DRY RUN]" : ""}`);

            summary = await runProductMatcherFromBuffer(buffer, fileName, dryRun);
        } else if (req.body) {
            // ─── 2. JSON PAYLOAD (Single Product or Array) ───
            const isArray = Array.isArray(req.body);
            let rawProducts = isArray ? req.body : [req.body];

            if (rawProducts.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: "Empty product array provided."
                });
            }

            console.log(`\n📥 [ProductsAPI] POST /api/products — JSON payload (${rawProducts.length} products). First product keys: ${Object.keys(rawProducts[0] || {}).join(', ')}`);

            const processedProducts = rawProducts.map(p => {
                let product = { ...p };
                // If product has a metadata object, flatten it
                if (product.metadata) {
                    product = { ...product, ...product.metadata };
                    delete product.metadata;
                }

                // Ensure we have a style_code (check common variants)
                if (!product.style_code && product.styleCode) product.style_code = product.styleCode;
                if (!product.style_code && product["style code"]) product.style_code = product["style code"];

                return product;
            });

            // Validate all have style_code
            const missingStyleCode = processedProducts.find(p => !p.style_code);
            if (missingStyleCode) {
                console.warn("⚠️ [ProductsAPI] Missing style_code in product:", JSON.stringify(missingStyleCode, null, 2));
                return res.status(400).json({
                    success: false,
                    error: "One or more products are missing required field: style_code",
                    offendingProduct: missingStyleCode
                });
            }

            summary = await runProductMatcherFromProducts(processedProducts, dryRun);
        } else {
            return res.status(400).json({
                success: false,
                error: "No data provided. Upload an .xlsx file as 'file' or send a JSON product body."
            });
        }

        return res.json({
            success: true,
            dry_run: dryRun,
            ...summary
        });
    } catch (err) {
        console.error("❌ [ProductsAPI] POST /api/products error:", err.message);
        return res.status(500).json({
            success: false,
            message: "Failed to process product upload.",
            error: err.message
        });
    }
});

module.exports = router;
