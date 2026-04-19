"use strict";

const express = require("express");
const config = require("./config");
const { startScraperJob } = require("./jobs/scraperJob");

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Liveness check — confirms the server is up and running.
 */
app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── API ROUTES ───
app.use("/api/events", require("./routes/eventRoutes"));
app.use("/api/products", require("./routes/productRoutes"));

// TODO: Add more API routes here as the backend grows
// e.g. app.use("/api/events", require("./routes/events"));

// ─── BOOT ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
    console.log(`\n🚀 MomentMap Backend running on http://localhost:${config.port}`);
    startScraperJob();
});

// Handle unhandled rejections and exceptions
process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
});

module.exports = app;
