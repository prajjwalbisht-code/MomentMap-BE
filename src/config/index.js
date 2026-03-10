"use strict";

require("dotenv").config();

module.exports = {
    port: process.env.PORT || 3001,

    aws: {
        region: process.env.AWS_REGION || "ap-south-1",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
        bucketName: process.env.S3_BUCKET_NAME || "",
    },

    openRouter: {
        apiKey: process.env.OPENROUTER_API_KEY || "",
        model: process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
    },

    pipeline: {
        targetCity: process.env.TARGET_CITY || "Bengaluru",
        productCatalogPath: process.env.PRODUCT_CATALOG_PATH || "products.tsv",
        topNProducts: parseInt(process.env.TOP_N_PRODUCTS || "20"),
    },
};
