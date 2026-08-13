import { chromium, Browser } from "playwright";
import { config } from "./config";
import { logger } from "./logger";

let browser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    logger.info("در حال راه‌اندازی مرورگر...");
    const b = await chromium.launch({ headless: config.headless });
    b.on("disconnected", () => {
      logger.warn("مرورگر قطع شد.");
      browser = null;
      launchPromise = null;
    });
    browser = b;
    launchPromise = null;
    logger.info("مرورگر آماده است.");
    return b;
  })();

  return launchPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    launchPromise = null;
  }
}
