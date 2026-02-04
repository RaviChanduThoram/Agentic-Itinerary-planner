import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(dir: string, filename: string, data: unknown) {
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function writeText(dir: string, filename: string, data: string) {
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, data, "utf8");
}
