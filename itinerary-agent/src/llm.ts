import OpenAI from "openai";
import type { Candidate, Itinerary, TavilyResult, TripRequest } from "./schema";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ============================================================
   Robust JSON extraction (balanced braces, string-safe)
   ============================================================ */

function extractFirstJsonSlice(
  raw: string,
  open: "{" | "[",
  close: "}" | "]"
): string {
  const start = raw.indexOf(open);
  if (start === -1) throw new Error("No JSON found");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) depth++;
    if (ch === close) depth--;

    if (depth === 0) return raw.slice(start, i + 1);
  }

  throw new Error("Unterminated JSON");
}

function extractFirstJsonObject(raw: string): any {
  return JSON.parse(extractFirstJsonSlice(raw, "{", "}"));
}

function extractFirstJsonArray(raw: string): any[] {
  return JSON.parse(extractFirstJsonSlice(raw, "[", "]"));
}

async function fixJsonOnly(raw: string, mode: "object" | "array"): Promise<string> {
  const instruction = `
You are a JSON repair assistant.
Return ONLY valid JSON ${mode === "array" ? "array" : "object"}.
No markdown, no commentary.
`.trim();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: raw }
    ],
    max_tokens: 1200,
    temperature: 0
  });

  return response.choices[0].message.content ?? "";
}

export async function parseJsonObjectSafe(raw: string): Promise<any> {
  try {
    return extractFirstJsonObject(raw);
  } catch {
    const fixed = await fixJsonOnly(raw, "object");
    return extractFirstJsonObject(fixed);
  }
}

export async function parseJsonArraySafe(raw: string): Promise<any[]> {
  try {
    return extractFirstJsonArray(raw);
  } catch {
    const fixed = await fixJsonOnly(raw, "array");
    return extractFirstJsonArray(fixed);
  }
}

/* ============================================================
   TripRequest extractor
   ============================================================ */

export async function extractTripRequest(userPrompt: string): Promise<string> {
  const instruction = `
Extract TripRequest from the user prompt.

Return ONLY valid JSON. No markdown. No commentary.

Keys EXACTLY:
destination,
tripLengthDays,
dates { start, end },
travelers,
budgetLevel,
pace,
interests,
constraints,
missingInfoQuestions

Rules:
- If user says "X-day trip" or "X days" => tripLengthDays = X.
- If user says "weekend" => tripLengthDays = 2.
- If trip length missing => tripLengthDays = 3 and add ONE question asking how many days.
- If dates missing => start/end = null and add ONE question asking dates.
- If travelers missing => 1.
- If budgetLevel missing => "mid".
- If pace missing => "balanced".
- interests and constraints can be empty arrays.
`.trim();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 450,
    temperature: 0
  });

  return response.choices[0].message.content ?? "";
}

/* ============================================================
   Candidates extractor (supports BOTH calling styles)
   ============================================================ */

// Overloads:
export async function extractCandidatesFromSearchResults(
  category: Candidate["category"],
  results: TavilyResult[],
  city: string
): Promise<string>;
export async function extractCandidatesFromSearchResults(input: {
  category: Candidate["category"];
  results: TavilyResult[];
  city: string;
}): Promise<string>;

// Implementation:
export async function extractCandidatesFromSearchResults(
  a:
    | Candidate["category"]
    | { category: Candidate["category"]; results: TavilyResult[]; city: string },
  b?: TavilyResult[],
  c?: string
): Promise<string> {
  const category = typeof a === "string" ? a : a.category;
  const results = typeof a === "string" ? (b ?? []) : a.results;
  const city = typeof a === "string" ? (c ?? "") : a.city;

  const instruction = `
You extract real venue/place names from web search results.

Return ONLY valid JSON ARRAY. No text.

Each item:
{ "name": string, "category": "${category}", "url": string, "notes": string }

Hard rules:
- name MUST be an actual venue/activity name (not article title, not guide, not question).
- Exclude names containing: best, top, guide, updated, things to do, restaurants in, what's the best.
- Prefer venues that plausibly exist in city: "${city}".
- If snippet lists multiple places, extract multiple candidates from one result.
- url must be the source result url.
- notes: short (e.g., "vegan sushi", "museum", "indoor activity").
`.trim();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: instruction },
      {
        role: "user",
        content: `City=${city}\nCategory=${category}\nResults=${JSON.stringify(results)}`
      }
    ],
    max_tokens: 900,
    temperature: 0.2
  });

  return response.choices[0].message.content ?? "";
}

/* ============================================================
   Itinerary generation (Option B)
   ============================================================ */

export async function generateItineraryOptionB(input: {
  trip: TripRequest;
  allowedAttractions: string[];
  allowedRestaurants: string[];
  allowedIndoorBackups: string[];
}): Promise<string> {
  const { trip, allowedAttractions, allowedRestaurants, allowedIndoorBackups } =
    input;

  const minBlocks =
    trip.pace === "relaxed" ? 2 : trip.pace === "balanced" ? 3 : 4;

  const maxBlocks =
    trip.pace === "relaxed" ? 3 : trip.pace === "balanced" ? 4 : 6;

  const instruction = `
You are a travel itinerary generator.

Return ONLY valid JSON object with:
summary, days, mustBook, rainBackups

STRICT RULES (NON-NEGOTIABLE):
- blocks[] are ATTRACTIONS ONLY. NEVER put restaurants in blocks.
- blocks[].title MUST be exactly one of allowedAttractions (string match).
- meals are MEALS ONLY. Meals MUST use only allowedRestaurants (string match).
- Each meal dish MUST clearly indicate vegetarian/vegan by including "(Vegetarian)" or "(Vegan)" in the dish text.
  Format each meal exactly:
    "Lunch: <Restaurant> - <Dish> (Vegetarian)"
    "Dinner: <Restaurant> - <Dish> (Vegan)"
- rainBackups MUST use only allowedIndoorBackups (string match).
- If you use anything else, the output is INVALID.

Structure per day:
{
  day,
  theme,
  blocks: [{ time, title, details }],
  meals: [
    "Lunch: <Restaurant> - <Dish> (Vegetarian)",
    "Dinner: <Restaurant> - <Dish> (Vegan)"
  ],
  notes: [at least 2]
}

Time format: "09:00 AM - 11:30 AM"
Blocks/day: ${minBlocks} to ${maxBlocks}
`.trim();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: instruction },
      {
        role: "user",
        content:
          `trip=${JSON.stringify(trip)}\n` +
          `allowedAttractions=${JSON.stringify(allowedAttractions)}\n` +
          `allowedRestaurants=${JSON.stringify(allowedRestaurants)}\n` +
          `allowedIndoorBackups=${JSON.stringify(allowedIndoorBackups)}`
      }
    ],
    max_tokens: 1900,
    temperature: 0.2
  });

  return response.choices[0].message.content ?? "";
}

/* ============================================================
   Evaluator
   ============================================================ */

export async function evaluateItineraryJson(args: {
  trip: TripRequest;
  itinerary: Itinerary;
  allowedAttractions: string[];
  allowedRestaurants: string[];
  allowedIndoorBackups: string[];
}): Promise<string> {
  const instruction = `
Evaluate itinerary quality.

Return ONLY valid JSON:
{ "score": number, "issues": string[], "fixes": string[] }
`.trim();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: JSON.stringify(args) }
    ],
    max_tokens: 700,
    temperature: 0
  });

  return response.choices[0].message.content ?? "";
}

/* ============================================================
   Revising (CRITICAL FIX)
   ============================================================ */

export async function reviseItineraryJson(args: {
  trip: TripRequest;
  itinerary: any;
  fixes: string[];
  allowedAttractions: string[];
  allowedRestaurants: string[];
  allowedIndoorBackups: string[];
  violations?: string[];
}): Promise<string> {
  const instruction = `
You are an itinerary reviser.

Return ONLY valid JSON Itinerary object.

NON-NEGOTIABLE RULES:
- blocks[] are ATTRACTIONS ONLY. NEVER put restaurants in blocks.
- blocks[].title MUST be exactly one of allowedAttractions (string match).
- meals are MEALS ONLY. Meals MUST use only allowedRestaurants (string match).
- Each meal dish MUST include "(Vegetarian)" or "(Vegan)" so it is explicit.
  Format each meal exactly:
    "Lunch: <Restaurant> - <Dish> (Vegetarian)"
    "Dinner: <Restaurant> - <Dish> (Vegan)"
- rainBackups MUST use only allowedIndoorBackups (string match).
- DO NOT invent new places.

REPAIR RULES:
- If a block title is a restaurant (in allowedRestaurants) or not in allowedAttractions, replace it with an item FROM allowedAttractions.
- If a meal restaurant is invalid, replace with an item FROM allowedRestaurants.
- If the meal dish is missing (Vegetarian)/(Vegan), add it.

FIX STRATEGY:
If a place is invalid:
1) Replace it with something FROM the allowed list
2) If no good replacement exists, REUSE an allowed item already used
3) Reuse is allowed; invention is NOT

SCHEMA REQUIREMENTS:
- MUST include: summary (string), days (array), mustBook (array), rainBackups (array)
- days.length MUST equal trip.tripLengthDays
- DO NOT return partial JSON or {}
`.trim();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: JSON.stringify(args) }
    ],
    max_tokens: 1900,
    temperature: 0.2
  });

  return response.choices[0].message.content ?? "";
}
