import { devices, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { logger } from "./logger";
import { encrypt, decrypt } from "./crypto";
import { getBrowser } from "./browserManager";

const LOGIN_URL = "https://login.emofid.com";
const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");
const DATA_DIR = path.join(__dirname, "..", "data");
const SESSION_FILE = path.join(DATA_DIR, "session.json");

export type OrderAction = "buy" | "sell";

export interface OrderResult {
  success: boolean;
  message: string;
  screenshotPaths: string[];
}

/* ─── debug helpers ─── */

function collectDebugFilesSince(startTime: number): string[] {
  if (!fs.existsSync(SCREENSHOT_DIR)) return [];
  return fs
    .readdirSync(SCREENSHOT_DIR)
    .map((name) => {
      const match = name.match(/^(\d+)_/);
      return match ? { name, time: parseInt(match[1], 10) } : null;
    })
    .filter((e): e is { name: string; time: number } => e !== null && e.time >= startTime)
    .sort((a, b) => a.time - b.time)
    .map((e) => path.join(SCREENSHOT_DIR, e.name));
}

const STEP_SLUGS: Record<string, string> = {
  "ورود به سایت": "login",
  "جستجوی نماد": "search-symbol",
  "خواندن قیمت": "read-price",
  "ثبت سفارش": "submit-order",
};

function slugify(step: string): string {
  let r = step;
  for (const [fa, slug] of Object.entries(STEP_SLUGS)) r = r.split(fa).join(slug);
  r = r.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return r || "step";
}

async function screenshot(page: Page, step: string): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${slugify(step)}.png`);
  await page.screenshot({ path: file, timeout: 10_000 });
  return file;
}

async function dumpHtml(page: Page, step: string): Promise<string | null> {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${slugify(step)}.html`);
    fs.writeFileSync(file, await page.content(), "utf-8");
    logger.debug(`HTML ذخیره شد: ${file}`);
    return file;
  } catch (err) {
    logger.error(`ذخیره‌ی HTML «${step}» شکست خورد: ${(err as Error).message}`);
    return null;
  }
}

async function screenshotBestEffort(page: Page, step: string): Promise<string | null> {
  try { return await screenshot(page, step); }
  catch { logger.error(`اسکرین‌شات «${step}» هم شکست خورد.`); return null; }
}

async function withStepScreenshotOnError<T>(page: Page, step: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (err) {
    const shot = await screenshotBestEffort(page, `FAILED_${step}`);
    const note = shot ? `\nاسکرین‌شات خطا: ${shot}` : "";
    throw new Error(`مرحله «${step}» شکست خورد: ${(err as Error).message}${note}`);
  }
}

async function withRetries<T>(attempts: number, action: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await action(); }
    catch (err) {
      lastErr = err;
      logger.warn(`تلاش ${i}/${attempts} ناموفق: ${(err as Error).message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

/* ─── encrypted session ─── */

function saveSessionData(state: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, encrypt(JSON.stringify(state)), "utf-8");
    logger.info("نشست ورود (رمزنگاری‌شده) ذخیره شد.");
  } catch (err) { logger.error(`ذخیره‌ی نشست شکست خورد: ${(err as Error).message}`); }
}

function loadSessionData(): Record<string, unknown> | null {
  if (!fs.existsSync(SESSION_FILE)) return null;
  const raw = fs.readFileSync(SESSION_FILE, "utf-8");
  try { return JSON.parse(decrypt(raw)); }
  catch {
    try {
      const obj = JSON.parse(raw);
      logger.warn("نشست قدیمی (بدون رمزنگاری) شناسایی شد.");
      return obj;
    } catch { logger.error("فایل نشست قابل خواندن نیست."); return null; }
  }
}

/* ─── تشخیص وضعیت نشست ─── */

async function isSessionAlive(page: Page): Promise<boolean> {
  if (page.url().includes("login.emofid.com")) {
    logger.debug("نشست منقضی: URL لاگین.");
    return false;
  }
  const hasSearchTab = await page
    .getByText("جستجو", { exact: true })
    .isVisible({ timeout: 4000 })
    .catch(() => false);
  if (!hasSearchTab) {
    logger.debug("نشست منقضی: تب «جستجو» نیست.");
    return false;
  }
  return true;
}

async function ensureLoggedIn(page: Page, context: BrowserContext): Promise<void> {
  if (await isSessionAlive(page)) return;
  logger.info("نشست منقضی شده -- ورود مجدد خودکار...");
  await login(page, context);
  if (!(await isSessionAlive(page))) throw new Error("ورود مجدد ناموفق بود.");
  logger.info("ورود مجدد موفق بود.");
}

/* ─── login ─── */

async function login(page: Page, context: BrowserContext): Promise<void> {
  await withStepScreenshotOnError(page, "ورود به سایت", async () => {
    await withRetries(3, () => page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }));
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const alreadyLoggedIn = await page
      .getByText("جستجو", { exact: true })
      .isVisible({ timeout: 6000 })
      .catch(() => false);
    if (alreadyLoggedIn) { logger.info("نشست ذخیره‌شده هنوز معتبر بود."); return; }

    const passwordField = page.locator('input[type="password"]').first();
    const onLoginForm = await passwordField.isVisible({ timeout: 5000 }).catch(() => false);
    if (!onLoginForm) {
      logger.info("فرم ورود مستقیم دیده نشد.");
      await page
        .getByRole("link", { name: "ورود", exact: true })
        .or(page.getByRole("button", { name: "ورود", exact: true }))
        .first()
        .click();
      await passwordField.waitFor({ state: "visible", timeout: 15000 });
      await screenshotBestEffort(page, "AFTER_CLICK_LOGIN_LINK");
    }

    const usernameField = page
      .locator('input[type="text"], input[type="tel"], input:not([type="password"])')
      .first();
    await usernameField.waitFor({ state: "visible", timeout: 15000 });
    await usernameField.fill(config.mofidUsername);
    await passwordField.fill(config.mofidPassword);
    await screenshotBestEffort(page, "AFTER_FILL");

    await page.getByRole("button", { name: "ورود", exact: true }).click();
    await page.waitForURL((url) => !url.hostname.includes("login.emofid.com"), { timeout: 20000 });
    await passwordField.waitFor({ state: "detached", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    for (let attempt = 1; attempt <= 3; attempt++) {
      const inApp = await page.getByText("جستجو", { exact: true }).isVisible({ timeout: 8000 }).catch(() => false);
      if (inApp) break;
      logger.warn(`اپ اصلی دیده نشد (تلاش ${attempt}/3).`);
      if (attempt === 3) throw new Error("اپ اصلی پیدا نشد.");
      const btn = page
        .getByRole("link", { name: "ورود", exact: true })
        .or(page.getByRole("button", { name: "ورود", exact: true }));
      if (await btn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await btn.first().click();
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      }
    }

    await screenshotBestEffort(page, "AFTER_LOGIN");
    const state = await context.storageState();
    saveSessionData(state as unknown as Record<string, unknown>);
  });
}

/* ─── open symbol ─── */

async function openSymbol(page: Page, context: BrowserContext, symbol: string): Promise<void> {
  await withStepScreenshotOnError(page, "جستجوی نماد", async () => {
    await ensureLoggedIn(page, context);
    await page.getByText("جستجو", { exact: true }).click();
    const searchBox = page.locator('input[type="search"], input[type="text"]').first();
    await searchBox.waitFor({ state: "visible", timeout: 10000 });
    await searchBox.fill(symbol);
    await page.getByText(symbol, { exact: true }).last().click();
    await page.getByText("خرید", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  });
}

/* ─── read price ─── */

async function readLastPrice(page: Page, context: BrowserContext): Promise<number> {
  return withStepScreenshotOnError(page, "خواندن قیمت", async () => {
    await ensureLoggedIn(page, context);
    const priceText = await page.locator("text=/\\d{1,3}(,\\d{3})+/").first().innerText();
    const price = parseInt(priceText.replace(/,/g, ""), 10);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`قیمت نامعتبر: "${priceText}"`);
    return price;
  });
}

/* ─── submit order ─── */

async function submitOrder(
  page: Page, context: BrowserContext, action: OrderAction, quantity: number
): Promise<{ confirmed: boolean; errorReason?: string }> {
  return withStepScreenshotOnError(page, "ثبت سفارش", async () => {
    await ensureLoggedIn(page, context);

    const buttonLabel = action === "buy" ? "خرید" : "فروش";
    await page.getByText(buttonLabel, { exact: true }).click();
    await dumpHtml(page, `ORDER_SHEET_OPEN_${action}`);

    const quantityField = page.locator("input:visible").first();
    await quantityField.waitFor({ state: "visible", timeout: 10000 });
    await quantityField.click();
    await quantityField.focus();
    await screenshotBestEffort(page, `AFTER_CLICK_QUANTITY_${action}`);

    const targetValue = String(quantity);
    const readValue = () => quantityField.inputValue().catch(() => "?");

    /* ─── بررسی و صفر کردن فیلد قبل از پر کردن ─── */

    const currentValue = await readValue();
    logger.debug(`مقدار فعلی فیلد تعداد: "${currentValue}"`);

    if (currentValue !== "" && currentValue !== "0") {
      logger.info(`فیلد تعداد "${currentValue}" است -- صفر می‌شود.`);

      // تلاش ۱: Control+A → Backspace
      await quantityField.click();
      await quantityField.press("Control+A").catch(() => {});
      await quantityField.press("Backspace").catch(() => {});
      await page.waitForTimeout(200);

      let afterClear = await readValue();

      // تلاش ۲: سلکت کامل + Delete
      if (afterClear !== "" && afterClear !== "0") {
        logger.warn(`فیلد هنوز "${afterClear}" -- clickCount:3 + Delete.`);
        await quantityField.click({ clickCount: 3 });
        await page.keyboard.press("Delete");
        await page.waitForTimeout(200);
        afterClear = await readValue();
      }

      // تلاش ۳: JS setter (صفر)
      if (afterClear !== "" && afterClear !== "0") {
        logger.warn(`فیلد هنوز "${afterClear}" -- JS setter.`);
        await quantityField.evaluate((el: HTMLInputElement) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          setter?.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.waitForTimeout(200);
        afterClear = await readValue();
      }

      if (afterClear !== "" && afterClear !== "0") {
        logger.warn(`بعد از ۳ تلاش، فیلد همچنان "${afterClear}" است.`);
      } else {
        logger.debug("فیلد تعداد با موفقیت صفر شد.");
      }
    }

    /* ─── وارد کردن مقدار جدید ─── */

    // روش ۱: pressSequentially
    await quantityField.click();
    await quantityField.focus();
    await quantityField.pressSequentially(targetValue, { timeout: 10000, delay: 150 }).catch((err) => {
      logger.debug(`روش ۱ خطا: ${(err as Error).message}`);
    });
    logger.debug(`مقدار بعد از روش ۱: "${await readValue()}"`);

    // روش ۲: page.keyboard
    if ((await readValue()) !== targetValue) {
      await quantityField.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(200);
      for (const digit of targetValue) {
        await page.keyboard.press(digit);
        await page.waitForTimeout(120);
      }
      logger.debug(`مقدار بعد از روش ۲: "${await readValue()}"`);
    }

    // روش ۳: JS setter
    if ((await readValue()) !== targetValue) {
      await quantityField.evaluate((el: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(el, value);
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      }, targetValue);
      logger.debug(`مقدار بعد از روش ۳: "${await readValue()}"`);
    }

    const finalValue = await readValue();
    if (finalValue !== targetValue) {
      logger.warn(`فیلد تعداد "${finalValue}" است، نه "${targetValue}".`);
    }

    await screenshotBestEffort(page, `AFTER_QUANTITY_${action}`);

    /* ─── ارسال سفارش ─── */

    const submitLabel = action === "buy" ? "ارسال خرید" : "ارسال فروش";
    const submitButton = page.getByRole("button", { name: submitLabel });
    await submitButton.waitFor({ state: "visible", timeout: 10000 });
    await submitButton.click();

    await page.waitForTimeout(700);
    await screenshotBestEffort(page, `RIGHT_AFTER_SUBMIT_${action}`);

    const toastPattern = action === "buy" ? /در سبد خرید ثبت شد/ : /در سبد فروش ثبت شد/;
    const knownErrors: Array<[RegExp, string]> = [
      [/مانده کاربر کافی نیست/, "موجودی/قدرت خرید حساب کافی نیست"],
      [/سقف (خرید|فروش)/, "سفارش از سقف مجاز خرید/فروش بیشتر است"],
    ];

    const successLocator = page.getByText(toastPattern);
    const errorLocators = knownErrors.map(([p]) => page.getByText(p));

    await successLocator
      .or(errorLocators[0])
      .or(errorLocators[1])
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {});

    const confirmed = await successLocator.isVisible().catch(() => false);
    let errorReason: string | undefined;
    if (!confirmed) {
      for (let i = 0; i < errorLocators.length; i++) {
        if (await errorLocators[i].isVisible().catch(() => false)) {
          errorReason = knownErrors[i][1];
          break;
        }
      }
    }

    await page.waitForTimeout(1500);
    await screenshot(page, `RESULT_${action}`);
    return { confirmed, errorReason };
  });
}

/* ─── نقطه ورود اصلی ─── */

export async function placeScheduledOrder(
  action: OrderAction, symbol: string, quantity: number
): Promise<OrderResult> {
  const startTime = Date.now();
  const browser = await getBrowser();
  let context: BrowserContext | null = null;

  try {
    const sessionData = loadSessionData();
    context = await browser.newContext({
      ...devices["iPhone 13"],
      ...(sessionData ? { storageState: sessionData as any } : {}),
    });
    const page = await context.newPage();

    await login(page, context);
    await openSymbol(page, context, symbol);
    const priceRial = await readLastPrice(page, context).catch(() => null);
    const { confirmed, errorReason } = await submitOrder(page, context, action, quantity);

    const approxTotal =
      priceRial !== null ? ` (≈ ${((quantity * priceRial) / 10).toLocaleString("fa-IR")} تومان)` : "";

    let message: string;
    if (confirmed) {
      message = `سفارش ${action === "buy" ? "خرید" : "فروش"} ${quantity} واحد ${symbol} ثبت شد${approxTotal}.`;
    } else if (errorReason) {
      message = `سفارش رد شد: ${errorReason}.`;
    } else {
      message = `دکمه‌ی ارسال زده شد ولی پیام تأیید دیده نشد -- اسکرین‌شات را چک کنید.`;
    }

    return { success: confirmed, message, screenshotPaths: collectDebugFilesSince(startTime) };
  } catch (err) {
    const page = browser.contexts()[0]?.pages()[0] ?? null;
    if (page) await screenshotBestEffort(page, "ERROR_final");
    return {
      success: false,
      message: `خطا: ${(err as Error).message}`,
      screenshotPaths: collectDebugFilesSince(startTime),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
    }
