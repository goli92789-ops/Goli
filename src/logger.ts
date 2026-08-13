import fs from "fs";
import path from "path";

const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLevel = 2;

export function setLogLevel(level: string): void {
  currentLevel = LEVELS[level] ?? 2;
}

function ensureDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level: string, message: string, meta?: Record<string, unknown>): void {
  if ((LEVELS[level] ?? 2) > currentLevel) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  const line = "[" + ts + "] [" + level.toUpperCase() + "] " + message + metaStr;
  level === "error" ? console.error(line) : console.log(line);
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch { /* best-effort */ }
}

export const logger = {
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => write("warn",  msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => write("info",  msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
};
