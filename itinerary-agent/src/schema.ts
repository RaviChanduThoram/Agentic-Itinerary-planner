import { z } from "zod";

/**
 * -------------------------
 * Trip Request (input)
 * -------------------------
 */
export const TripRequestSchema = z.object({
  destination: z.string().min(1),
  tripLengthDays: z.number().int().min(1).max(30),
  dates: z.object({
    start: z.string().nullable(),
    end: z.string().nullable()
  }),
  travelers: z.number().int().min(1).max(20),
  budgetLevel: z.enum(["low", "mid", "high"]),
  pace: z.enum(["relaxed", "balanced", "packed"]),
  interests: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  missingInfoQuestions: z.array(z.string()).default([])
});
export type TripRequest = z.infer<typeof TripRequestSchema>;

/**
 * -------------------------
 * Candidates (from web)
 * -------------------------
 */
export const CandidateSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["restaurant", "attraction", "indoor_backup"]),
  url: z.string().url(),
  notes: z.string().optional()
});
export type Candidate = z.infer<typeof CandidateSchema>;

/**
 * -------------------------
 * Tavily Results
 * -------------------------
 */
export const TavilyResultSchema = z.object({
  title: z.string().default(""),
  url: z.string().url(),
  content: z.string().default("")
});
export type TavilyResult = z.infer<typeof TavilyResultSchema>;

/**
 * -------------------------
 * LLM Itinerary (Option B output)
 * This is the model output schema: blocks + meals strings
 * -------------------------
 */
export const DayBlockSchema = z.object({
  time: z.string().min(1), // enforced as range by prompt + validator
  title: z.string().min(1),
  details: z.string().optional()
});

export const DayPlanSchema = z.object({
  day: z.number().int().min(1),
  theme: z.string().min(1),
  blocks: z.array(DayBlockSchema).min(2),
  meals: z.array(z.string()).min(2),
  notes: z.array(z.string()).default([])
});

export const ItinerarySchema = z.object({
  summary: z.string().min(1),
  days: z.array(DayPlanSchema).min(1),
  mustBook: z.array(z.string()).default([]),
  rainBackups: z.array(z.string()).default([]),
  estimatedDailyCostRange: z.string().optional()
});
export type Itinerary = z.infer<typeof ItinerarySchema>;

/**
 * -------------------------
 * UI Itinerary (API output to frontend)
 * This is what your backend returns now: days[].timeline[] with imageUrl
 * -------------------------
 */
export const UiActivityItemSchema = z.object({
  kind: z.literal("activity"),
  time: z.string().min(1),
  title: z.string().min(1),
  details: z.string().optional(),
  imageUrl: z.string().url().optional()
});

export const UiMealItemSchema = z.object({
  kind: z.literal("meal"),
  time: z.string().min(1),
  mealType: z.enum(["Lunch", "Dinner"]),
  place: z.string().min(1),
  dishIdea: z.string().min(1),
  imageUrl: z.string().url().optional()
});

export const UiTimelineItemSchema = z.union([UiActivityItemSchema, UiMealItemSchema]);
export type UiTimelineItem = z.infer<typeof UiTimelineItemSchema>;

export const UiDaySchema = z.object({
  day: z.number().int().min(1),
  theme: z.string().min(1),
  timeline: z.array(UiTimelineItemSchema).min(1),
  notes: z.array(z.string()).default([])
});
export type UiDay = z.infer<typeof UiDaySchema>;

export const UiItinerarySchema = z.object({
  summary: z.string().min(1),
  days: z.array(UiDaySchema).min(1),
  mustBook: z.array(z.string()).default([]),
  rainBackups: z.array(z.string()).default([])
});
export type UiItinerary = z.infer<typeof UiItinerarySchema>;

/**
 * -------------------------
 * API Response schema (optional but recommended)
 * -------------------------
 */
export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  violations: z.array(z.string()).default([])
});

export const AllowedListsSchema = z.object({
  allowedAttractions: z.array(z.string()).default([]),
  allowedRestaurants: z.array(z.string()).default([]),
  allowedIndoorBackups: z.array(z.string()).default([])
});

export const PlanResponseSchema = z.object({
  itinerary: UiItinerarySchema,
  allowedLists: AllowedListsSchema,
  validation: ValidationResultSchema
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
