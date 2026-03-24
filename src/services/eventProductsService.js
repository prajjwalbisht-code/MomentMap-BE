"use strict";

const fs = require("fs");
const path = require("path");
const { matchProductObjects } = require("./productService");

async function attachMatchedProductsToEvent(eventInput) {
    const products = await matchProductObjects(eventInput);
    return {
        ...eventInput,
        products,
    };
}

async function writeEventWithMatchedProducts(eventInput, outputPath = "event_with_products.json") {
    const enrichedEvent = await attachMatchedProductsToEvent(eventInput);
    const fullOutputPath = path.isAbsolute(outputPath)
        ? outputPath
        : path.join(process.cwd(), outputPath);

    fs.writeFileSync(fullOutputPath, JSON.stringify(enrichedEvent, null, 2), "utf-8");
    return { outputPath: fullOutputPath, event: enrichedEvent };
}

module.exports = {
    attachMatchedProductsToEvent,
    writeEventWithMatchedProducts,
};
