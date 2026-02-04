import { generateItineraryOptionB, parseJsonObjectSafe, reviseItineraryJson } from "./llm";
import type { Candidate, Itinerary, TripRequest } from "./schema";
import { ItinerarySchema, TripRequestSchema } from "./schema";
import { buildCandidatesForCity } from "./tools/buildCandidates";
import { validateItineraryProduction } from "./validate";

function cap<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(0, n) : arr;
}

function unique(arr: string[]) {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

function looksLikeItinerary(obj: any) {
  return obj && typeof obj === "object" && typeof obj.summary === "string" && Array.isArray(obj.days);
}

function allowedListsFromCandidates(candidates: Candidate[]) {
  const allowedAttractions = unique(candidates.filter(c => c.category === "attraction").map(c => c.name));
  const allowedRestaurants = unique(candidates.filter(c => c.category === "restaurant").map(c => c.name));
  const allowedIndoorBackups = unique(candidates.filter(c => c.category === "indoor_backup").map(c => c.name));

  return {
    allowedAttractions: cap(allowedAttractions, 60),
    allowedRestaurants: cap(allowedRestaurants, 40),
    allowedIndoorBackups: cap(allowedIndoorBackups, 30)
  };
}

// Convert your current "blocks + meals strings" itinerary format into UI "timeline" format
function toTimelineDay(day: any) {
  const timeline: any[] = [];

  for (const b of day.blocks ?? []) {
    timeline.push({ kind: "activity", time: b.time, title: b.title, details: b.details });
  }

  // add meal times (simple defaults; later we’ll make these dynamic)
  const meals: string[] = day.meals ?? [];
  const lunch = meals.find(m => m.toLowerCase().startsWith("lunch:"));
  const dinner = meals.find(m => m.toLowerCase().startsWith("dinner:"));

  if (lunch) {
    const rest = lunch.replace(/^Lunch:\s*/i, "");
    const [place, dishIdea] = rest.split(" - ").map(s => s.trim());
    const insertAt = timeline.length >= 2 ? 1 : timeline.length;
    timeline.splice(insertAt, 0, {
      kind: "meal",
      time: "12:15 PM - 01:15 PM",
      mealType: "Lunch",
      place,
      dishIdea
    });
  }

  if (dinner) {
    const rest = dinner.replace(/^Dinner:\s*/i, "");
    const [place, dishIdea] = rest.split(" - ").map(s => s.trim());
    timeline.push({
      kind: "meal",
      time: "06:30 PM - 08:00 PM",
      mealType: "Dinner",
      place,
      dishIdea
    });
  }

  return {
    day: day.day,
    theme: day.theme,
    timeline,
    notes: day.notes ?? []
  };
}

function toUiItinerary(itinerary: any) {
  return {
    summary: itinerary.summary,
    days: (itinerary.days ?? []).map(toTimelineDay),
    mustBook: itinerary.mustBook ?? [],
    rainBackups: itinerary.rainBackups ?? []
  };
}

export async function planFromIntake(input: {
  destination: string;
  startDate: string;
  endDate: string;
  travelers: number;
  pace: "relaxed" | "balanced" | "packed";
  budgetLevel: "low" | "mid" | "high";
  constraints: string[];
  interests: string[];
}) {
  // inclusive day count
  const start = new Date(input.startDate + "T00:00:00");
  const end = new Date(input.endDate + "T00:00:00");
  const diff = end.getTime() - start.getTime();
  const tripLengthDays = Math.max(1, Math.floor(diff / (24 * 60 * 60 * 1000)) + 1);

  const tripObj: any = {
    destination: input.destination,
    tripLengthDays,
    dates: { start: input.startDate, end: input.endDate },
    travelers: input.travelers,
    budgetLevel: input.budgetLevel,
    pace: input.pace,
    interests: input.interests ?? [],
    constraints: input.constraints ?? [],
    missingInfoQuestions: []
  };

  const trip = TripRequestSchema.parse(tripObj) as TripRequest;

  // Candidates + allowed lists
  const candidates = await buildCandidatesForCity(trip.destination);
  const { allowedAttractions, allowedRestaurants, allowedIndoorBackups } =
    allowedListsFromCandidates(candidates);

  // Generate itinerary
  const raw = await generateItineraryOptionB({
    trip,
    allowedAttractions,
    allowedRestaurants,
    allowedIndoorBackups
  });

  const itObj = await parseJsonObjectSafe(raw);
  if (!looksLikeItinerary(itObj)) throw new Error("Model did not return itinerary-shaped JSON.");

  let itinerary = ItinerarySchema.parse(itObj) as Itinerary;

  // Validate + revise (bounded)
  let validation = validateItineraryProduction(trip, itinerary, allowedAttractions, allowedRestaurants, allowedIndoorBackups);

  for (let i = 0; i < 2 && !validation.ok; i++) {
    const revisedRaw = await reviseItineraryJson({
      trip,
      itinerary,
      fixes: ["Fix all violations strictly using allowed lists and Option B rules."],
      allowedAttractions,
      allowedRestaurants,
      allowedIndoorBackups,
      violations: validation.violations
    });

    const revisedObj = await parseJsonObjectSafe(revisedRaw);
    if (looksLikeItinerary(revisedObj)) {
      itinerary = ItinerarySchema.parse(revisedObj) as Itinerary;
    }
    validation = validateItineraryProduction(trip, itinerary, allowedAttractions, allowedRestaurants, allowedIndoorBackups);
  }

  // Final response shape the frontend expects
  return {
    itinerary: toUiItinerary(itinerary),
    allowedLists: { allowedAttractions, allowedRestaurants, allowedIndoorBackups },
    validation
  };
}
