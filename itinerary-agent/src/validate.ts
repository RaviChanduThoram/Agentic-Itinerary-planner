import type { Itinerary, TripRequest } from "./schema";

export type ValidationResult = {
  ok: boolean;
  violations: string[];
};

function isTimeRange(s: string) {
  // very simple check: contains " - " somewhere
  return s.includes(" - ");
}

function extractRestaurantNameFromMeal(meal: string): string | null {
  // Expected: "Lunch: Restaurant - dish"
  const parts = meal.split(":");
  if (parts.length < 2) return null;
  const afterColon = parts.slice(1).join(":").trim();
  // Restaurant part before first " - "
  const rest = afterColon.split(" - ")[0].trim();
  return rest || null;
}

export function validateItineraryProduction(
  trip: TripRequest,
  itinerary: Itinerary,
  allowedAttractions: string[],
  allowedRestaurants: string[],
  allowedIndoorBackups: string[]
): ValidationResult {
  const violations: string[] = [];

  // Day count and numbering
  if (itinerary.days.length !== trip.tripLengthDays) {
    violations.push(`days.length=${itinerary.days.length} must equal tripLengthDays=${trip.tripLengthDays}`);
  }
  const dayNums = itinerary.days.map(d => d.day).sort((a,b)=>a-b);
  for (let i = 1; i <= trip.tripLengthDays; i++) {
    if (dayNums[i-1] !== i) violations.push(`Missing or wrong day number: expected day ${i}`);
  }

  // Pace rules: blocks per day
  for (const day of itinerary.days) {
    const blocks = day.blocks.length;
    const pace = trip.pace;
    const ok =
      (pace === "relaxed" && blocks >= 2 && blocks <= 3) ||
      (pace === "balanced" && blocks >= 3 && blocks <= 4) ||
      (pace === "packed" && blocks >= 4 && blocks <= 6);

    if (!ok) violations.push(`Day ${day.day} blocks=${blocks} violates pace=${pace}`);
  }

  // Notes: at least 2 per day
  for (const day of itinerary.days) {
    if ((day.notes?.length ?? 0) < 2) violations.push(`Day ${day.day} notes must have at least 2 items`);
  }

  // Blocks: attraction-only + allowed list + time range
  const allowedAttractionSet = new Set(allowedAttractions);
  for (const day of itinerary.days) {
    for (const b of day.blocks) {
      if (!isTimeRange(b.time)) violations.push(`Day ${day.day} block time not a range: "${b.time}"`);
      if (!allowedAttractionSet.has(b.title)) violations.push(`Invalid attraction in blocks: "${b.title}"`);
      // Option B: no restaurants in blocks
      if (b.title.toLowerCase().includes("lunch") || b.title.toLowerCase().includes("dinner")) {
        violations.push(`Block title includes dining text (Option B): "${b.title}"`);
      }
    }
  }

  // Meals: must include Lunch: and Dinner:, restaurants must be allowed
  const allowedRestaurantSet = new Set(allowedRestaurants);
  for (const day of itinerary.days) {
    const hasLunch = day.meals.some(m => m.startsWith("Lunch:"));
    const hasDinner = day.meals.some(m => m.startsWith("Dinner:"));
    if (!hasLunch) violations.push(`Day ${day.day} missing Lunch: in meals`);
    if (!hasDinner) violations.push(`Day ${day.day} missing Dinner: in meals`);

    for (const meal of day.meals) {
      const rest = extractRestaurantNameFromMeal(meal);
      if (!rest) violations.push(`Meal format invalid: "${meal}"`);
      else if (!allowedRestaurantSet.has(rest)) violations.push(`Invalid restaurant in meals: "${rest}"`);
      // Vegetarian constraint (basic check: mention veg dish)
      if (trip.constraints.includes("vegetarian")) {
        const lower = meal.toLowerCase();
        const vegHints = ["veg", "vegetarian", "vegan", "plant", "tofu", "paneer", "lentil", "chickpea", "vegetable"];
        if (!vegHints.some(h => lower.includes(h))) {
          violations.push(`Meal may not clearly indicate vegetarian dish: "${meal}"`);
        }
      }
    }
  }

  // Rain backups: allowed list only
  const allowedIndoorSet = new Set(allowedIndoorBackups);
  for (const rb of itinerary.rainBackups ?? []) {
    if (!allowedIndoorSet.has(rb)) violations.push(`Invalid rain backup (not in allowedIndoorBackups): "${rb}"`);
  }

  return { ok: violations.length === 0, violations };
}
