import "dotenv/config";
import crypto from "node:crypto";

import {
    ItinerarySchema,
    TripRequestSchema,
    type Candidate,
    type Itinerary,
    type TripRequest
} from "./schema";

import {
    evaluateItineraryJson,
    extractTripRequest,
    generateItineraryOptionB,
    parseJsonObjectSafe,
    reviseItineraryJson
} from "./llm";

import { TtlCache } from "./cache";
import { writeJson, writeText } from "./runArtifacts";
import { validateItineraryProduction } from "./validate";

// NOTE: Your buildCandidates + tavilySearch live in tools/
import { buildCandidatesForCity } from "./tools/buildCandidates";

const cache = new TtlCache(24 * 60 * 60 * 1000); // 24h

function cap<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(0, n) : arr;
}

function unique(arr: string[]) {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

function allowedListsFromCandidates(candidates: Candidate[]) {
  const allowedAttractions = unique(
    candidates.filter((c) => c.category === "attraction").map((c) => c.name)
  );
  const allowedRestaurants = unique(
    candidates.filter((c) => c.category === "restaurant").map((c) => c.name)
  );
  const allowedIndoorBackups = unique(
    candidates.filter((c) => c.category === "indoor_backup").map((c) => c.name)
  );

  // Keep prompts bounded
  return {
    allowedAttractions: cap(allowedAttractions, 25),
    allowedRestaurants: cap(allowedRestaurants, 25),
    allowedIndoorBackups: cap(allowedIndoorBackups, 15)
  };
}

function looksLikeItinerary(obj: any) {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.summary === "string" &&
    Array.isArray(obj.days)
  );
}

async function main() {
  const requestId = crypto.randomUUID();
  const runDir = `runs/${requestId}`;

  const userPrompt =
    process.argv.slice(2).join(" ") ||
    "Plan a 3-day trip to Chicago for a couple, vegetarian, mid budget.";

  // 1) Extract TripRequest
  const rawTrip = await extractTripRequest(userPrompt);
  writeText(runDir, "rawTripRequest.txt", rawTrip);

  const tripObj = await parseJsonObjectSafe(rawTrip);
  const trip = TripRequestSchema.parse(tripObj) as TripRequest;

  // 2) Build candidates (cached by destination)
  const candCacheKey = `candidates:${trip.destination.toLowerCase()}`;
  let candidates = cache.get<Candidate[]>(candCacheKey);
  if (!candidates) {
    candidates = await buildCandidatesForCity(trip.destination);
    cache.set(candCacheKey, candidates, 24 * 60 * 60 * 1000);
  }
  writeJson(runDir, "candidates.json", candidates);

  const { allowedAttractions, allowedRestaurants, allowedIndoorBackups } =
    allowedListsFromCandidates(candidates);

  writeJson(runDir, "allowedLists.json", {
    allowedAttractions,
    allowedRestaurants,
    allowedIndoorBackups
  });

  // 3) Generate itinerary
  const rawItinerary = await generateItineraryOptionB({
    trip,
    allowedAttractions,
    allowedRestaurants,
    allowedIndoorBackups
  });
  writeText(runDir, "rawItinerary.txt", rawItinerary);

  // 4) Parse itinerary JSON
  const itObj = await parseJsonObjectSafe(rawItinerary);

  if (!looksLikeItinerary(itObj)) {
    throw new Error(
      `Model did not return an Itinerary-shaped JSON. Check ${runDir}/rawItinerary.txt`
    );
  }

  // 5) Zod parse
  let itinerary: Itinerary = ItinerarySchema.parse(itObj) as Itinerary;

  // 6) Validate with your production validator
  let validation = validateItineraryProduction(
    trip,
    itinerary,
    allowedAttractions,
    allowedRestaurants,
    allowedIndoorBackups
  );
  writeJson(runDir, "validation1.json", validation);

  // 7) If violations → revise once
  if (!validation.ok) {
    const rawRevise1 = await reviseItineraryJson({
      trip,
      itinerary,
      fixes: ["Fix all violations strictly using allowed lists and Option B rules."],
      allowedAttractions,
      allowedRestaurants,
      allowedIndoorBackups,
      violations: validation.violations
    });
    writeText(runDir, "rawRevise1.txt", rawRevise1);

    const revisedObj = await parseJsonObjectSafe(rawRevise1);

    // ✅ CRITICAL FIX: if revise output is partial/invalid, force schema-fix revise
    if (!looksLikeItinerary(revisedObj)) {
      const rawRevise1SchemaFix = await reviseItineraryJson({
        trip,
        itinerary,
        fixes: [
          "Return a FULL Itinerary JSON object (not partial).",
          "Must include: summary (string) and days (array). Never omit them.",
          "Fix all violations strictly using allowed lists and Option B rules."
        ],
        allowedAttractions,
        allowedRestaurants,
        allowedIndoorBackups,
        violations: validation.violations
      });
      writeText(runDir, "rawRevise1_schemaFix.txt", rawRevise1SchemaFix);

      const fixedObj = await parseJsonObjectSafe(rawRevise1SchemaFix);
      itinerary = ItinerarySchema.parse(fixedObj) as Itinerary;
    } else {
      itinerary = ItinerarySchema.parse(revisedObj) as Itinerary;
    }

    validation = validateItineraryProduction(
      trip,
      itinerary,
      allowedAttractions,
      allowedRestaurants,
      allowedIndoorBackups
    );
    writeJson(runDir, "validation2.json", validation);
  }

  // 8) Evaluator + optional optimize pass
  const rawEval = await evaluateItineraryJson({
    trip,
    itinerary,
    allowedAttractions,
    allowedRestaurants,
    allowedIndoorBackups
  });
  writeText(runDir, "rawEval.txt", rawEval);

  const evalObj = await parseJsonObjectSafe(rawEval);
  writeJson(runDir, "eval.json", evalObj);

  const score = typeof evalObj.score === "number" ? evalObj.score : 0;
  const fixes = Array.isArray(evalObj.fixes) ? evalObj.fixes : [];

  if (score < 90 && fixes.length > 0) {
    const rawRevise2 = await reviseItineraryJson({
      trip,
      itinerary,
      fixes,
      allowedAttractions,
      allowedRestaurants,
      allowedIndoorBackups
    });
    writeText(runDir, "rawRevise2.txt", rawRevise2);

    const revisedObj2 = await parseJsonObjectSafe(rawRevise2);

    // ✅ Same guard again
    if (!looksLikeItinerary(revisedObj2)) {
      const rawRevise2SchemaFix = await reviseItineraryJson({
        trip,
        itinerary,
        fixes: [
          "Return a FULL Itinerary JSON object (not partial).",
          "Must include: summary (string) and days (array). Never omit them.",
          "Apply the evaluator fixes strictly using allowed lists only."
        ],
        allowedAttractions,
        allowedRestaurants,
        allowedIndoorBackups
      });
      writeText(runDir, "rawRevise2_schemaFix.txt", rawRevise2SchemaFix);

      const fixedObj2 = await parseJsonObjectSafe(rawRevise2SchemaFix);
      itinerary = ItinerarySchema.parse(fixedObj2) as Itinerary;
    } else {
      itinerary = ItinerarySchema.parse(revisedObj2) as Itinerary;
    }

    const validation3 = validateItineraryProduction(
      trip,
      itinerary,
      allowedAttractions,
      allowedRestaurants,
      allowedIndoorBackups
    );
    writeJson(runDir, "validation3.json", validation3);
  }

  // Final output
  writeJson(runDir, "itinerary.json", itinerary);

  console.log("\nREQUEST ID:", requestId);
  console.log("\nTRIP REQUEST:\n", JSON.stringify(trip, null, 2));
  console.log("\nFINAL ITINERARY:\n", JSON.stringify(itinerary, null, 2));
  console.log(`\nSaved run artifacts in: ${runDir}\n`);
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
