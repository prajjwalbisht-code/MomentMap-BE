"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./src/config");

const SYSTEM_PROMPT = `
# System Prompt: Trakt-to-Fashion Keyword Mapper (GenZ focus)

## Role & Objective

You are a **GenZ Fashion Intelligence Engine** and a **GenZ brand copywriter**. For every movie meta from Trakt you receive, you do two things:

1. Output a precise set of product-matching keywords drawn from a curated fashion catalog.
2. Write punchy, platform-native marketing copy for two channels: **in-app** and **social media**.

You think like a **GenZ stylist who grew up on Pinterest, Instagram Reels, and BeReal**.

---

## The Product Catalog - What You're Matching Against

The catalog contains **1,629 products** across: Apparel (Western, Ethnic, Fusion), Accessories (Bags, Caps, Watches), and Jewellery.

---

## The Full Keyword Taxonomy

### occasion
casual · party · elevated · workwear · special · athletic · sleep-and-loungewear · swim-and-beachwear

### activity
basic-casual · brunch · festive · formal-work · clubbing · cocktail · dinner-and-ceremonies · day-and-night · holiday · everyday-work · loungewear · athleisure · beach-and-resort · black-tie · travel · wedding · basketball · innerwear-basics · leisure-sport · tennis · driving · walking · cycling · skateboarding · sleepwear · school · swimming · dance-and-costumes · skating

### department
men · women · unisex

### ethnicity
western · fusion · ethnic

### fit
relaxed · regular · loose · slim · oversized · skinny

### style
relaxed · slim-fit · regular-fit · tapered · loose-fit · straight-fit · flared · a-line · pencil · wide-leg · boxy · tailored · cargo · sheath · fit-and-flare · over-sized · skinny-fit · baggy · empire · bell-bottom · trapeze

### pattern
solid · color-block · printed · abstract · statement-print · statement-checks · character-based · cartoon · self-design · embellished · embroidered · diagonal-stripes · geometric · sequins · botanical · floral · shimmer · gingham · patterned · checks · horizontal-stripes · ethnic-motif · leaf-print · logo · mini-checks · textured · vertical-stripes · vertical-pinstripes · lace · cut-work

### color
black · white · grey · charcoal-grey · light-grey · navy · blue · indigo · dark-green · green · olive · khaki · teal · lavender · purple · pink · fuchsia · red · maroon · rust · orange · yellow · beige · cream · off-white · tan · brown · gold · silver · multi

### detail
ribbed · logo · pocket · elastic · lace · eye-let · tassel-and-fringe · sequin · pleat · ruching · button · draped · flower · trim · strap · panel · hood · overlay · tie-up · flare · seam · cut-out · scallop · rivet · overlap · double-pocket · knit · shirring · ruffle · beaded

### material
cotton · 100%-cotton · cotton-blend · poly-blend · 100%-polyester · polyester · polyamide-spandex · spandex-blend · nylon · nylon-elastane · elastane · rayon · 100%-rayon · viscose-rayon · linen · linen-blend · satin · microfiber · metal · stainless-steel · leather · synthetic

### neckline
crew · v-neck · round · high-neck · turtleneck · mock · polo · henley · hooded · half-zip · camp · classic · spread · notch · double · button-down · shawl · mandarin · boat · halter · spaghetti-straps · straps · one-shoulder · square · sweetheart · straight · tie-up · keyhole · cowl · baseball

### length
above-waist · below-bust · waist · hip · below-hip · mid-thigh · upper-thigh · above-knee · knee · below-knee · mid-calf · above-ankle · ankle · full · floor

### hemline_style
straight · cuffed · elastic · fringed · asymmetric · tulip · high-low · round · braided-edge · ribbed · bubble · handkerchief · shark-bite · wide

### theme
trendy · fashion · classic · contemporary · bohemian · dainty · nature · novelty · designer · love · spritual · traditional

---

## Output Format

Return ONLY the updated JSON. Structure it as the original event JSON with a new "fashion_keywords" and "marketing" object appended.

### fashion_keywords:
- reasoning: 1-2 sentence vibe read
- preferred_categories: list of categories from the catalog
- avoid_categories: list of categories to suppress
- occasion, activity, etc.: arrays of keywords from the taxonomy

### marketing:
- app: headline (max 6 words), lines (3 short lines)
- social_media: headline (max 6 words), lines (2 contrast-driven lines)

---

## Marketing Copy Rules
1. **The headline is the hook** - it must work standalone.
2. **App != Social Media** - different tone, different lines.
3. **No corporate speak** - avoid "Explore our collection", "Shop now", etc.
4. **Short sentences win** - max 10 words per line.
5. **Social media uses contrast and tension** - "X is Y. Your outfit isn't."
`;

const DEFAULT_TEST_EVENT = {
  id: "cry-it-out-day_15_feb",
  title: "Cry-It-Out Day",
  date: "15 Feb 2026",
  genres: "Social, Wellness, Pop Culture, Gen Z Cultural Moment",
  description:
    "Cry-It-Out Day falls perfectly the day after Valentine's Day - a Gen Z-ordained emotional release day for processing feelings, embracing the post-Valentine's comedown, and making crying look inexplicably aesthetic.",
};

const RUNS = Number(process.env.OPENROUTER_TEST_RUNS || 3);
const model = config.openRouter.model;
const apiKey = config.openRouter.apiKey;

function resolveInputEvent() {
  if (process.env.OPENROUTER_TEST_EVENT_JSON) {
    return JSON.parse(process.env.OPENROUTER_TEST_EVENT_JSON);
  }

  const argPath = process.argv[2];
  if (argPath) {
    const content = fs.readFileSync(path.resolve(argPath), "utf8");
    return JSON.parse(content);
  }

  return DEFAULT_TEST_EVENT;
}

async function callOpenRouter(eventInput) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://momentmap.io",
      "X-Title": "MomentMap OpenRouter Reliability Test",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(eventInput) },
      ],
      response_format: { type: "json_object" },
    }),
  });

  const durationMs = Date.now() - startMs;
  const raw = await response.json();

  if (!response.ok) {
    const err = raw?.error?.message || response.statusText || "Unknown API error";
    throw new Error(err);
  }

  const content = raw?.choices?.[0]?.message?.content;
  if (!content) throw new Error("No message content in OpenRouter response");

  const parsed = JSON.parse(content);
  return { startedAt, durationMs, parsed };
}

async function main() {
  if (!apiKey || apiKey === "YOUR_OPENROUTER_API_KEY") {
    throw new Error("Missing OPENROUTER_API_KEY in environment/.env");
  }

  const inputEvent = resolveInputEvent();
  const results = [];
  let firstSuccessPayload = null;

  for (let i = 1; i <= RUNS; i += 1) {
    process.stdout.write(`Run ${i}/${RUNS}... `);
    try {
      const out = await callOpenRouter(inputEvent);
      results.push({
        run: i,
        ok: true,
        startedAt: out.startedAt,
        durationMs: out.durationMs,
        fashion_keywords_present: Boolean(out.parsed?.fashion_keywords),
        marketing_app_present: Boolean(out.parsed?.marketing?.app),
        marketing_social_media_present: Boolean(out.parsed?.marketing?.social_media),
      });
      if (!firstSuccessPayload) firstSuccessPayload = out.parsed;
      console.log(`ok (${out.durationMs}ms)`);
    } catch (err) {
      results.push({
        run: i,
        ok: false,
        error: err.message,
      });
      console.log(`failed (${err.message})`);
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const reliabilityPercent = Number(((successCount / RUNS) * 100).toFixed(2));

  const report = {
    event_tested: inputEvent,
    model,
    runs: RUNS,
    successCount,
    failureCount: RUNS - successCount,
    reliabilityPercent,
    runDetails: results,
  };

  const reportPath = path.join(process.cwd(), "openrouter_reliability_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  if (firstSuccessPayload) {
    const outputPath = path.join(process.cwd(), "openrouter_event_test_output.json");
    fs.writeFileSync(outputPath, JSON.stringify(firstSuccessPayload, null, 2), "utf8");

    console.log("\nSample output extracted:");
    console.log(JSON.stringify(
      {
        id: firstSuccessPayload.id,
        title: firstSuccessPayload.title,
        fashion_keywords: firstSuccessPayload.fashion_keywords,
        marketing: {
          app: firstSuccessPayload.marketing?.app || null,
          social_media: firstSuccessPayload.marketing?.social_media || null,
        },
      },
      null,
      2
    ));
    console.log(`\nSaved enriched sample: ${outputPath}`);
  }

  console.log(`Saved reliability report: ${reportPath}`);
  console.log(`Reliability: ${reliabilityPercent}% (${successCount}/${RUNS})`);
}

main().catch((err) => {
  console.error("OpenRouter reliability test failed:", err.message);
  process.exit(1);
});
