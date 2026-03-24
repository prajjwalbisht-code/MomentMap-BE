"use strict";

/**
 * Generates a URL-friendly slug from a string.
 * @param {string} text 
 * @returns {string}
 */
function slugify(text) {
    return (text || "")
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-")           // Replace spaces with -
        .replace(/[^\w-]+/g, "")       // Remove all non-word chars
        .replace(/--+/g, "-")           // Replace multiple - with single -
        .replace(/^-+/, "")             // Trim - from start of text
        .replace(/-+$/, "");            // Trim - from end of text
}

/**
 * Generates a unique event ID following the pattern:
 * slugify(title) + "_" + DD + "_" + MMM
 * @param {string} title 
 * @param {string} dateStr - Date string from BMS (e.g. "15 Mar" or "15/03")
 * @returns {string}
 */
function generateEventId(title, dateStr) {
    const slug = slugify(title);

    // Attempt to extract Day and Month from dateStr
    // BMS dates are often like "15 Mar", "Sat 15 Mar", "15/03"
    let day = "00";
    let month = "unknown";

    if (dateStr) {
        const dayMatch = dateStr.match(/\b(\d{1,2})\b/);
        if (dayMatch) day = dayMatch[1].padStart(2, '0');

        const monthMatch = dateStr.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
        if (monthMatch) {
            month = monthMatch[1].toLowerCase();
        } else {
            // Fallback for numeric months: 15/03 or ISO 2026-03-15
            const numMonthMatch = dateStr.match(/[/-](\d{1,2})\b/);
            if (numMonthMatch) {
                const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
                const mIdx = parseInt(numMonthMatch[1], 10) - 1;
                if (mIdx >= 0 && mIdx < 12) month = months[mIdx];
            }
        }
    }

    return `${slug}_${day}_${month}`;
}

module.exports = { slugify, generateEventId };
