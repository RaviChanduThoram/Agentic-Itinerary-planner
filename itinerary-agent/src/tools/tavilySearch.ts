import { tavily } from "@tavily/core";
import { TavilyResultSchema, type TavilyResult } from "../schema";

export async function tavilySearch(query: string, maxResults = 6): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("Missing TAVILY_API_KEY in .env");

  const client = tavily({ apiKey });
  const res = await client.search(query, { max_results: maxResults, search_depth: "basic" });

  const results = (res.results ?? []).map((r: any) => ({
    title: r.title ?? "",
    url: r.url,
    content: r.content ?? ""
  }));

  // validate/normalize
  return results.map(r => TavilyResultSchema.parse(r));
}
