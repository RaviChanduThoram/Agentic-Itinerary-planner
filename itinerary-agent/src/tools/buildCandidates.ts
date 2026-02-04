import { extractCandidatesFromSearchResults, parseJsonArraySafe } from "../llm";
import { CandidateSchema, type Candidate, type TavilyResult } from "../schema";
import { tavilySearch } from "./tavilySearch";

function isJunkName(name: string): boolean {
  const n = name.toLowerCase();
  const junk = [
    "best",
    "top",
    "guide",
    "updated",
    "things to do",
    "restaurants in",
    "what's the best",
    "tripadvisor",
    "yelp",
    "opentable",
    "viator",
    "getyourguide"
  ];
  if (name.length > 70) return true;
  return junk.some((w) => n.includes(w));
}

function dedupe(cands: Candidate[]) {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of cands) {
    const key = c.name.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function cap<T>(arr: T[], n: number) {
  return arr.slice(0, n);
}

async function extractAndValidate(
  category: Candidate["category"],
  results: TavilyResult[],
  city: string
): Promise<Candidate[]> {
  const raw = await extractCandidatesFromSearchResults(category, results, city);
  const arr = (await parseJsonArraySafe(raw)) as any[];

  const out: Candidate[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    try {
      const c = CandidateSchema.parse(item);
      if (!isJunkName(c.name)) out.push(c);
    } catch {
      // ignore invalid items
    }
  }
  return out;
}

export async function buildCandidatesForCity(city: string): Promise<Candidate[]> {
  // Increase breadth: multiple queries per category so canonical places don’t get missed.
  const [
    vegResults,

    // attractions (multiple angles)
    attractionsA,
    attractionsB,
    attractionsC,
    attractionsD,

    // indoor backups (multiple angles)
    indoorA,
    indoorB
  ] = await Promise.all([
    // Restaurants
    tavilySearch(`best vegetarian restaurants in ${city}`, 8),

    // Attractions
    tavilySearch(`must see attractions in ${city}`, 8),
    tavilySearch(`most famous landmarks in ${city}`, 8),
    tavilySearch(`best museums in ${city}`, 8),
    tavilySearch(`best family friendly attractions in ${city}`, 8),

    // Indoor backups
    tavilySearch(`best indoor things to do in ${city} rainy day`, 8),
    tavilySearch(`best indoor attractions in ${city}`, 8)
  ]);

  // Extract:
  // - Restaurants from vegResults
  // - Attractions from all attraction result sets (including museums!)
  // - Indoor backups from indoor result sets
  const [
    restaurants,
    attr1,
    attr2,
    attr3,
    attr4,
    indoor1,
    indoor2
  ] = await Promise.all([
    extractAndValidate("restaurant", vegResults as TavilyResult[], city),

    extractAndValidate("attraction", attractionsA as TavilyResult[], city),
    extractAndValidate("attraction", attractionsB as TavilyResult[], city),
    extractAndValidate("attraction", attractionsC as TavilyResult[], city),
    extractAndValidate("attraction", attractionsD as TavilyResult[], city),

    extractAndValidate("indoor_backup", indoorA as TavilyResult[], city),
    extractAndValidate("indoor_backup", indoorB as TavilyResult[], city)
  ]);

  let all: Candidate[] = [
    ...restaurants,
    ...attr1,
    ...attr2,
    ...attr3,
    ...attr4,
    ...indoor1,
    ...indoor2
  ];

  all = dedupe(all);

  // Cap totals to control tokens
  const restaurantsOut = cap(all.filter((c) => c.category === "restaurant"), 40);
  const attractionsOut = cap(all.filter((c) => c.category === "attraction"), 60);
  const indoorOut = cap(all.filter((c) => c.category === "indoor_backup"), 30);

  return [...restaurantsOut, ...attractionsOut, ...indoorOut];
}
