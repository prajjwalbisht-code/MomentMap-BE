import { NextResponse } from "next/server";
const { runProductMatcherFromProducts } = require("../../../../../productMatcher");

export async function POST(request) {
  try {
    const body = await request.json();

    const normalizeKeys = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) {
        const clean = k.trim().toLowerCase().replace(/\s+/g, "_");
        out[clean] = v;
      }
      return out;
    };

    const product = normalizeKeys(body);
    const styleCode = product.style_code || product["style code"];
    if (!styleCode) {
      return NextResponse.json(
        { success: false, error: "Missing required field: style_code" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dry_run") === "true";

    const summary = await runProductMatcherFromProducts([product], dryRun);

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      products_in_file: 1,
      events_in_s3: summary.events_in_s3,
      new_links_added: summary.new_links_added,
      events_with_new_products: summary.events_with_new_products,
      matches: summary.matches,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
