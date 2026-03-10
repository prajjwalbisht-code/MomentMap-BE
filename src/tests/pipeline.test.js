"use strict";

const { slugify, generateEventId } = require("../utils/slugify");

function testSlugify() {
    console.log("Testing slugify...");
    const tests = [
        ["Hello World", "hello-world"],
        ["Sunburn Arena ft. Martin Garrix", "sunburn-arena-ft-martin-garrix"],
        ["  Extra  Spaces  ", "extra-spaces"],
        ["Special @#$% Chars", "special-chars"],
    ];

    tests.forEach(([input, expected]) => {
        const actual = slugify(input);
        if (actual === expected) {
            console.log(`  ✅ "${input}" -> "${actual}"`);
        } else {
            console.error(`  ❌ "${input}" -> "${actual}" (expected "${expected}")`);
            process.exit(1);
        }
    });
}

function testGenerateEventId() {
    console.log("\nTesting generateEventId...");
    const tests = [
        { title: "Martin Garrix", date: "15 Mar", expected: "martin-garrix_15_mar" },
        { title: "Sunburn", date: "Sat 16 Mar", expected: "sunburn_16_mar" },
        { title: "Movie", date: "15/03", expected: "movie_15_mar" },
    ];

    tests.forEach(({ title, date, expected }) => {
        const actual = generateEventId(title, date);
        if (actual === expected) {
            console.log(`  ✅ "${title}" @ "${date}" -> "${actual}"`);
        } else {
            console.error(`  ❌ "${title}" @ "${date}" -> "${actual}" (expected "${expected}")`);
            process.exit(1);
        }
    });
}

try {
    testSlugify();
    testGenerateEventId();
    console.log("\n✨ All pipeline unit tests passed!");
} catch (e) {
    console.error(e);
    process.exit(1);
}
