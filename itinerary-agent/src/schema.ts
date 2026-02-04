import { z } from "zod";

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

export const CandidateSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["restaurant", "attraction", "indoor_backup"]),
  url: z.string().url(),
  notes: z.string().optional()
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const TavilyResultSchema = z.object({
  title: z.string().default(""),
  url: z.string().url(),
  content: z.string().default("")
});
export type TavilyResult = z.infer<typeof TavilyResultSchema>;

export const DayBlockSchema = z.object({
  time: z.string().min(1),   // enforced as range by prompt + validator
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
