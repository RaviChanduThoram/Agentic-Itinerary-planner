import cors from "cors";
import "dotenv/config";
import express from "express";
import { z } from "zod";
import { planFromIntake } from "./planFromIntake";

const app = express();

// If you use Vite proxy, CORS is optional. But keeping it on is fine.
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const IntakeSchema = z.object({
  destination: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  travelers: z.number().int().min(1).default(1),
  pace: z.enum(["relaxed", "balanced", "packed"]).default("balanced"),
  budgetLevel: z.enum(["low", "mid", "high"]).default("mid"),
  constraints: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([])
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/plan", async (req, res) => {
  const parsed = IntakeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send(parsed.error.message);

  try {
    const data = await planFromIntake(parsed.data);
    return res.json(data);
  } catch (e: any) {
    return res.status(500).send(e?.message ?? "Server error");
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Backend listening on http://localhost:${port}`));
