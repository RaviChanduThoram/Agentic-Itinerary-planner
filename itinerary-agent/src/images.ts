// src/images.ts
// Google Places-powered media resolver: multi images + ratings + maps URL.
//
// This file is used by the backend only.
// It resolves Google Place photo references to their final CDN URLs so we DO NOT
// leak GOOGLE_MAPS_API_KEY to the frontend.

import { TtlCache } from "./cache";

export type PlaceMedia = {
  placeId: string;
  name?: string;
  address?: string;
  rating?: number;
  userRatingsTotal?: number;
  mapsUrl?: string;
  imageUrls: string[];
};

export type HotelOption = {
  name: string;
  address?: string;
  rating?: number;
  userRatingsTotal?: number;
  mapsUrl?: string;
  imageUrls: string[];
};

type GooglePlacePhoto = {
  photo_reference: string;
};

type GoogleTextSearchResult = {
  place_id: string;
  name: string;
  formatted_address?: string;
  rating?: number;
  user_ratings_total?: number;
  photos?: GooglePlacePhoto[];
};

type GoogleTextSearchResponse = {
  status: string;
  error_message?: string;
  results?: GoogleTextSearchResult[];
};

type GooglePlaceDetailsResult = {
  place_id: string;
  name?: string;
  formatted_address?: string;
  rating?: number;
  user_ratings_total?: number;
  url?: string;
  photos?: GooglePlacePhoto[];
};

type GooglePlaceDetailsResponse = {
  status: string;
  error_message?: string;
  result?: GooglePlaceDetailsResult;
};

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const detailsCache = new TtlCache(DEFAULT_TTL_MS);
const textSearchCache = new TtlCache(DEFAULT_TTL_MS);
const photoRedirectCache = new TtlCache(DEFAULT_TTL_MS);

function requireGoogleKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      "Missing GOOGLE_MAPS_API_KEY. Add it to your backend .env (billing must be enabled for Places APIs)."
    );
  }
  return key;
}

function mapsPlaceIdUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
}

async function googleGetJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google API HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function googleTextSearch(query: string): Promise<GoogleTextSearchResult[]> {
  const cacheKey = `textsearch::${query.toLowerCase().trim()}`;
  const cached = textSearchCache.get<GoogleTextSearchResult[]>(cacheKey);
  if (cached) return cached;

  const key = requireGoogleKey();
  const url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}` +
    `&key=${encodeURIComponent(key)}`;

  const data = await googleGetJson<GoogleTextSearchResponse>(url);

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(
      `Google Places textsearch failed: ${data.status}${data.error_message ? ` (${data.error_message})` : ""}`
    );
  }

  const results = (data.results ?? []).filter((r) => r?.place_id && r?.name);
  textSearchCache.set(cacheKey, results);
  return results;
}

async function googlePlaceDetails(placeId: string): Promise<GooglePlaceDetailsResult | null> {
  const cacheKey = `details::${placeId}`;
  const cached = detailsCache.get<GooglePlaceDetailsResult>(cacheKey);
  if (cached) return cached;

  const key = requireGoogleKey();
  // Keep fields tight to avoid unnecessary billing.
  const fields = [
    "place_id",
    "name",
    "formatted_address",
    "rating",
    "user_ratings_total",
    "url",
    "photos"
  ].join(",");

  const url =
    "https://maps.googleapis.com/maps/api/place/details/json" +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=${encodeURIComponent(fields)}` +
    `&key=${encodeURIComponent(key)}`;

  const data = await googleGetJson<GooglePlaceDetailsResponse>(url);
  if (data.status !== "OK") {
    if (data.status === "ZERO_RESULTS" || data.status === "NOT_FOUND") return null;
    throw new Error(
      `Google Place details failed: ${data.status}${data.error_message ? ` (${data.error_message})` : ""}`
    );
  }
  const result = data.result ?? null;
  if (!result?.place_id) return null;
  detailsCache.set(cacheKey, result);
  return result;
}

async function resolvePhotoRedirect(photoRef: string, maxWidth = 1600): Promise<string | null> {
  const cacheKey = `photo::${photoRef}::${maxWidth}`;
  const cached = photoRedirectCache.get<string>(cacheKey);
  if (cached) return cached;

  const key = requireGoogleKey();
  const url =
    "https://maps.googleapis.com/maps/api/place/photo" +
    `?maxwidth=${encodeURIComponent(String(maxWidth))}` +
    `&photoreference=${encodeURIComponent(photoRef)}` +
    `&key=${encodeURIComponent(key)}`;

  // We want the final Location URL (cdn), not the bytes.
  const res = await fetch(url, { redirect: "manual" });
  const status = res.status;
  const location = res.headers.get("location");

  if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && location) {
    photoRedirectCache.set(cacheKey, location);
    return location;
  }

  // If runtime followed redirects automatically, Location won't exist.
  return null;
}

function uniqStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const key = (s ?? "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Resolve a place (attraction/restaurant/hotel) into media fields.
 *   textsearch("<name> <city>") -> place_id
 *   details(place_id) -> photos, rating, address
 *   photo(photo_reference) -> final CDN url(s)
 */
export async function resolvePlaceMedia(args: {
  name: string;
  city: string;
  maxImages?: number;
}): Promise<PlaceMedia | null> {
  const name = args.name.trim();
  const city = args.city.trim();
  if (!name || !city) return null;

  const maxImages = Math.max(1, Math.min(args.maxImages ?? 5, 10));

  const query = `${name} ${city}`;
  const results = await googleTextSearch(query);
  const best = results[0];
  if (!best?.place_id) return null;

  const details = await googlePlaceDetails(best.place_id);
  const photos = details?.photos ?? best.photos ?? [];
  const photoRefs = uniqStrings(photos.map((p) => p.photo_reference)).slice(0, maxImages);

  const imageUrls: string[] = [];
  for (const ref of photoRefs) {
    const finalUrl = await resolvePhotoRedirect(ref);
    if (finalUrl) imageUrls.push(finalUrl);
  }

  return {
    placeId: best.place_id,
    name: details?.name ?? best.name,
    address: details?.formatted_address ?? best.formatted_address,
    rating: (details?.rating ?? best.rating) as number | undefined,
    userRatingsTotal: (details?.user_ratings_total ?? best.user_ratings_total) as number | undefined,
    mapsUrl: details?.url ?? mapsPlaceIdUrl(best.place_id),
    imageUrls
  };
}

/**
 * Resolve many places into a map.
 */
export async function resolvePlacesMedia(args: {
  city: string;
  places: string[];
  maxImagesPerPlace?: number;
  concurrency?: number;
}): Promise<Record<string, PlaceMedia>> {
  const city = args.city.trim();
  const places = uniqStrings(args.places).slice(0, 80);
  const maxImagesPerPlace = args.maxImagesPerPlace ?? 5;
  const concurrency = Math.max(1, Math.min(args.concurrency ?? 6, 10));

  const out: Record<string, PlaceMedia> = {};
  let idx = 0;

  async function worker() {
    while (idx < places.length) {
      const name = places[idx++];
      try {
        const media = await resolvePlaceMedia({ name, city, maxImages: maxImagesPerPlace });
        if (media) out[name] = media;
      } catch {
        // ignore per-place failures
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

/**
 * Fetch "top" hotels for a city using Places Text Search.
 * For now (no pricing), we return: name/address/rating/photos.
 */
export async function getHotelsForCity(args: {
  city: string;
  maxHotels?: number;
  maxImagesPerHotel?: number;
}): Promise<HotelOption[]> {
  const city = args.city.trim();
  if (!city) return [];

  const maxHotels = Math.max(1, Math.min(args.maxHotels ?? 10, 20));
  const maxImagesPerHotel = Math.max(1, Math.min(args.maxImagesPerHotel ?? 6, 10));

  const results = await googleTextSearch(`best hotels in ${city}`);
  const hotels = results.filter((r) => r?.place_id && r?.name).slice(0, maxHotels);

  const out: HotelOption[] = [];
  for (const h of hotels) {
    const details = await googlePlaceDetails(h.place_id);
    const photos = details?.photos ?? h.photos ?? [];
    const photoRefs = uniqStrings(photos.map((p) => p.photo_reference)).slice(0, maxImagesPerHotel);

    const imageUrls: string[] = [];
    for (const ref of photoRefs) {
      const finalUrl = await resolvePhotoRedirect(ref);
      if (finalUrl) imageUrls.push(finalUrl);
    }

    out.push({
      name: details?.name ?? h.name,
      address: details?.formatted_address ?? h.formatted_address,
      rating: (details?.rating ?? h.rating) as number | undefined,
      userRatingsTotal: (details?.user_ratings_total ?? h.user_ratings_total) as number | undefined,
      mapsUrl: details?.url ?? mapsPlaceIdUrl(h.place_id),
      imageUrls
    });
  }

  return out;
}
