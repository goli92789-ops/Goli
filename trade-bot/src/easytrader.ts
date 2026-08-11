import { chromium, Browser, Page } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "./config";

const LOGIN_URL = "https://login.emofid.com";
const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");

export type OrderAction = "buy" | "sell";

export interface OrderResult {
  success: boolean;
  message: string;
  screenshotPath: string;
}

/**
 * Every selector below was written from screenshots of a real login/search/order
 * walkthrough (not a live inspected page), except where noted. The very first
 * live run should be watched closely (small test amount) -- if a step fails,
 * the thrown error names the step and a screenshot of that exact moment is
 * saved, which is enough to fix the one broken selector without redoing the rest.
 */
async function screenshot(page: Page, step: string): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${step}.png`);
  await page.screenshot({ path: file, fullPage: true, timeout: 10_000 });
  return file;
}

/** Never lets a failed error-screenshot hide the real error that caused it. */
async function screenshotBestEffort(page: Page, step: string): Promise<string | null> {
  try {
    return await screenshot(page, step);
  } catch (screenshotErr) {
    console.error(`گرفتن اسکرین‌شات «${step}» هم شکست خورد:`, screenshotErr);
    return null;
  }
}

async function withStepScreenshotOnError<T>(
  page: Page,
  step: string,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    const shot = await screenshotBestEffort(page, `FAILED_${step}`);
    const shotNote = shot ? `\nاسکرین‌شات لحظه‌ی خطا: ${shot}` : "\n(گرفتن اسکرین‌شات هم ناموفق بود)";
    throw new Error(`مرحله «${step}» شکست خورد: ${(err as Error).message}${shotNote}`);
  }
}

async function login(page: Page): Promise<void> {
  await withStepScreenshotOnError(page, "ورود به سایت", async () => {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // Username field: no confirmed selector yet, falls back through a few guesses.
    const usernameField = page
      .locator('input[type="text"], input[type="tel"], input:not([type="password"])')
      .first();
    await usernameField.waitFor({ state: "visible", timeout: 15000 });
    await usernameField.fill(config.mofidUsername);

    const passwordField = page.locator('input[type="password"]').first();
    await passwordField.fill(config.mofidPassword);

    await page.getByRole("button", { name: "ورود" }).click();

    // Wait for navigation away from the login page as confirmation.
    await page.waitForURL((url) => !url.hostname.includes("login.emofid.com"), {
      timeout: 20000,
    });
  });
}

async function openSymbol(page: Page, symbol: string): Promise<void> {
  await withStepScreenshotOnError(page, "جستجوی نماد", async () => {
    await page.getByText("جستجو", { exact: true }).click();
    const searchBox = page.locator('input[type="search"], input[type="text"]').first();
    await searchBox.waitFor({ state: "visible", timeout: 10000 });
    await searchBox.fill(symbol);

    // Result row shows the symbol name as bold text under an ETF/fund group heading.
    await page.getByText(symbol, { exact: true }).last().click();

    // Confirm we're on the symbol detail page (buy/sell buttons visible).
    await page.getByText("خرید", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  });
}

async function readLastPrice(page: Page): Promise<number> {
  return withStepScreenshotOnError(page, "خواندن قیمت", async () => {
    // The big price number sits at the top of the symbol detail page.
    const priceText = await page.locator("text=/\\d{1,3}(,\\d{3})+/").first().innerText();
    const price = parseInt(priceText.replace(/,/g, ""), 10);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`قیمت خوانده‌شده نامعتبر بود: "${priceText}"`);
    }
    return price;
  });
}

async function submitOrder(
  page: Page,
  action: OrderAction,
  quantity: number
): Promise<{ screenshotPath: string; confirmed: boolean }> {
  return withStepScreenshotOnError(page, "ثبت سفارش", async () => {
    const buttonLabel = action === "buy" ? "خرید" : "فروش";
    await page.getByText(buttonLabel, { exact: true }).click();

    // Order sheet: quantity input is the first numeric text field in the sheet.
    const quantityField = page.getByLabel("تعداد").or(page.locator('input[type="text"]').first());
    await quantityField.waitFor({ state: "visible", timeout: 10000 });
    await quantityField.fill(String(quantity));

    const submitLabel = action === "buy" ? "ارسال خرید" : "ارسال فروش";
    const submitButton = page.getByRole("button", { name: submitLabel });
    await submitButton.waitFor({ state: "visible", timeout: 10000 });
    await submitButton.click();

    // Submitting doesn't open a confirmation dialog -- the platform sends the
    // order straight to the exchange and shows a toast like "در سبد خرید ثبت شد"
    // ("در سبد فروش ثبت شد" for sell). That toast is the real success signal.
    const toastPattern = action === "buy" ? /در سبد خرید ثبت شد/ : /در سبد فروش ثبت شد/;
    const confirmed = await page
      .getByText(toastPattern)
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    await page.waitForTimeout(1500);
    const screenshotPath = await screenshot(page, `RESULT_${action}`);
    return { screenshotPath, confirmed };
  });
}

export async function placeScheduledOrder(
  action: OrderAction,
  symbol: string,
  quantity: number
): Promise<OrderResult> {
  const browser: Browser = await chromium.launch({ headless: config.headless });
  try {
    const page = await browser.newPage();

    await login(page);
    await openSymbol(page, symbol);

    // Best-effort only: used purely to show an approximate Toman total in the
    // report, never to compute the quantity. A failed price read must not
    // block placing the order.
    const priceRial = await readLastPrice(page).catch(() => null);

    const { screenshotPath, confirmed } = await submitOrder(page, action, quantity);

    const approxTotal =
      priceRial !== null
        ? ` (≈ ${((quantity * priceRial) / 10).toLocaleString("fa-IR")} تومان)`
        : "";

    return {
      success: confirmed,
      message:
        (confirmed
          ? `سفارش ${action === "buy" ? "خرید" : "فروش"} ${quantity} واحد ${symbol} ثبت شد${approxTotal}.`
          : `دکمه‌ی ارسال زده شد ولی پیام «در سبد ${action === "buy" ? "خرید" : "فروش"} ثبت شد» دیده نشد -- ` +
            `اسکرین‌شات را چک کنید، ممکن است سفارش ثبت نشده باشد.`),
      screenshotPath,
    };
  } catch (err) {
    const page = browser.contexts()[0]?.pages()[0] ?? null;
    const screenshotPath = (page ? await screenshotBestEffort(page, "ERROR_final") : null) ?? "";
    return {
      success: false,
      message: `خطا: ${(err as Error).message}`,
      screenshotPath,
    };
  } finally {
    await browser.close();
  }
}
