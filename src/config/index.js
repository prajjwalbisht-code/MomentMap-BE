"use strict";

require("dotenv").config();

const matchingRules = require("./matchingRules");

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
        topNProducts: parseInt(process.env.TOP_N_PRODUCTS || "40", 10),
        debugScoring: process.env.DEBUG_SCORING === "true",
        enableMatchingTelemetry: process.env.ENABLE_MATCHING_TELEMETRY === "true",
    },
    matching: matchingRules,

    trakt: {
        clientId: process.env.TRAKT_CLIENT_ID || "d7da1d4532a4cef098e031d7abb07309e48b8ba38e97af5a92b0259b816467b9",
    },

    tmdb: {
        apiKey: process.env.TMDB_API_KEY || "0017eb7dcb532efaafacdf3eb6ae8ddb",
    },
};
