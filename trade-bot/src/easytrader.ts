import { chromium, devices, Browser, Page } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "./config";

const LOGIN_URL = "https://login.emofid.com";
const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");

export type OrderAction = "buy" | "sell";

export interface OrderResult {
  success: boolean;
  message: string;
  screenshotPaths: string[];
}

/** Every screenshot/HTML dump is named "{timestamp}_...", so everything written during one run can be found after the fact without threading a collector through every step function. */
function collectDebugFilesSince(startTime: number): string[] {
  if (!fs.existsSync(SCREENSHOT_DIR)) return [];
  return fs
    .readdirSync(SCREENSHOT_DIR)
    .map((name) => {
      const match = name.match(/^(\d+)_/);
      return match ? { name, time: parseInt(match[1], 10) } : null;
    })
    .filter((entry): entry is { name: string; time: number } => entry !== null && entry.time >= startTime)
    .sort((a, b) => a.time - b.time)
    .map((entry) => path.join(SCREENSHOT_DIR, entry.name));
}

/**
 * Every selector below was written from screenshots of a real login/search/order
 * walkthrough (not a live inspected page), except where noted. The very first
 * live run should be watched closely (small test amount) -- if a step fails,
 * the thrown error names the step and a screenshot of that exact moment is
 * saved, which is enough to fix the one broken selector without redoing the rest.
 */
// Persian step names (with spaces) made 404s common when typed/pasted into a
// phone browser -- screenshot filenames now use fixed ASCII slugs instead.
// Messages shown to the user still use the Persian step names.
const STEP_SLUGS: Record<string, string> = {
  "ورود به سایت": "login",
  "جستجوی نماد": "search-symbol",
  "خواندن قیمت": "read-price",
  "ثبت سفارش": "submit-order",
};

function slugify(step: string): string {
  let result = step;
  for (const [persian, slug] of Object.entries(STEP_SLUGS)) {
    result = result.split(persian).join(slug);
  }
  result = result.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "step";
}

async function screenshot(page: Page, step: string): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${slugify(step)}.png`);
  // Viewport-only (not fullPage): fullPage screenshots on a long/slow-loading
  // page can hang waiting for every font/image on the page to settle.
  await page.screenshot({ path: file, timeout: 10_000 });
  return file;
}

/** Saves the full rendered HTML for manual inspection (grep on the server) when a selector keeps missing. */
async function dumpHtml(page: Page, step: string): Promise<string | null> {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${slugify(step)}.html`);
    const html = await page.content();
    fs.writeFileSync(file, html, "utf-8");
    console.log(`HTML صفحه ذخیره شد: ${file}`);
    return file;
  } catch (err) {
    console.error(`ذخیره‌ی HTML «${step}» شکست خورد:`, err);
    return null;
  }
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

/** Retries a flaky, side-effect-free step (like loading a page) a few times before giving up. */
async function withRetries<T>(attempts: number, action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastError = err;
      console.log(`تلاش ${attempt} از ${attempts} شکست خورد: ${(err as Error).message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  throw lastError;
}

async function login(page: Page): Promise<void> {
  await withStepScreenshotOnError(page, "ورود به سایت", async () => {
    // The network to login.emofid.com is occasionally slow/flaky; retrying a
    // page load is harmless (unlike retrying the order submit further down).
    await withRetries(3, () => page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }));

    const beforeFillShot = await screenshotBestEffort(page, "BEFORE_FILL");
    console.log(`اسکرین‌شات قبل از پر کردن فرم: ${beforeFillShot ?? "ناموفق"}`);

    // login.emofid.com sometimes lands on the easytrader.ir marketing homepage
    // instead of the login form directly. A password field is the real
    // signal we're on the form; if it's missing, click through "ورود" first.
    const passwordField = page.locator('input[type="password"]').first();
    const onLoginForm = await passwordField.isVisible({ timeout: 5000 }).catch(() => false);
    if (!onLoginForm) {
      console.log("فرم ورود مستقیم دیده نشد (احتمالاً صفحه‌ی تبلیغاتی)، روی لینک «ورود» کلیک می‌کنیم.");
      await page.getByRole("link", { name: "ورود", exact: true })
        .or(page.getByRole("button", { name: "ورود", exact: true }))
        .first()
        .click();
      await passwordField.waitFor({ state: "visible", timeout: 15000 });
      await screenshotBestEffort(page, "AFTER_CLICK_LOGIN_LINK");
    }

    // Username field: no confirmed selector yet, falls back through a few guesses.
    const usernameField = page
      .locator('input[type="text"], input[type="tel"], input:not([type="password"])')
      .first();
    await usernameField.waitFor({ state: "visible", timeout: 15000 });
    await usernameField.fill(config.mofidUsername);

    await passwordField.fill(config.mofidPassword);

    const afterFillShot = await screenshotBestEffort(page, "AFTER_FILL");
    console.log(`اسکرین‌شات بعد از پر کردن فرم (قبل از ارسال): ${afterFillShot ?? "ناموفق"}`);

    await page.getByRole("button", { name: "ورود", exact: true }).click();

    // Hostname changing alone isn't a strong enough signal (an SPA route
    // change or a failed-login reload can also satisfy it) -- also require
    // the password field itself to actually disappear. If credentials were
    // wrong, this step now fails loudly instead of reporting a false success.
    await page.waitForURL((url) => !url.hostname.includes("login.emofid.com"), { timeout: 20000 });
    await passwordField.waitFor({ state: "detached", timeout: 20000 });

    // The app is a single-page app -- give it time to finish loading after
    // the redirect before anything tries to click on it.
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
      console.log("صفحه بعد از ورود کاملاً بی‌کار (idle) نشد، ادامه می‌دهیم.");
    });

    // Even after a genuine login, the browser sometimes lands on the
    // easytrader.ir marketing page again (an intermediate redirect hop)
    // instead of the authenticated app. Only the bottom-nav "جستجو" tab
    // confirms we're actually in the app; if it's missing, click through
    // the marketing page's login button again (session should now carry
    // over) up to twice more before giving up.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const inApp = await page
        .getByText("جستجو", { exact: true })
        .isVisible({ timeout: 8000 })
        .catch(() => false);
      if (inApp) break;

      console.log(`اپ اصلی هنوز دیده نشد (تلاش ${attempt} از 3) -- احتمالاً دوباره صفحه‌ی تبلیغاتی.`);
      await screenshotBestEffort(page, `STILL_MARKETING_${attempt}`);
      if (attempt === 3) {
        throw new Error("بعد از ورود، اپ اصلی (تب «جستجو») پیدا نشد -- احتمالاً هنوز روی صفحه‌ی تبلیغاتی است.");
      }

      const loginButton = page
        .getByRole("link", { name: "ورود", exact: true })
        .or(page.getByRole("button", { name: "ورود", exact: true }));
      if (await loginButton.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await loginButton.first().click();
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      }
    }

    const shot = await screenshotBestEffort(page, "AFTER_LOGIN");
    console.log(`اسکرین‌شات بعد از ورود: ${shot ?? "ناموفق"}`);
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
): Promise<{ confirmed: boolean; errorReason?: string }> {
  return withStepScreenshotOnError(page, "ثبت سفارش", async () => {
    const buttonLabel = action === "buy" ? "خرید" : "فروش";
    await page.getByText(buttonLabel, { exact: true }).click();

    await screenshotBestEffort(page, `ORDER_SHEET_OPEN_${action}`);
    await dumpHtml(page, `ORDER_SHEET_OPEN_${action}`);

    // Order sheet: quantity is the first VISIBLE input, price (with a lock
    // icon) is the second. Plain input.first() kept resolving to a hidden
    // input earlier in the DOM (confirmed by the error log: "locator
    // resolved to hidden" 21 times) -- Playwright's :visible pseudo-class
    // filters those out.
    const quantityField = page.locator("input:visible").first();
    await quantityField.waitFor({ state: "visible", timeout: 10000 });

    // fill() failed with "element is not editable" -- likely readonly and
    // driven by a custom numeric keypad (the calculator icon next to it).
    // Click to focus/open it, then try real keystrokes; if the field is
    // truly readonly even to typing, fall back to setting the value via JS
    // and firing the input/change events a framework-controlled field
    // listens for.
    await quantityField.click();
    await quantityField.focus();
    await screenshotBestEffort(page, `AFTER_CLICK_QUANTITY_${action}`);

    const targetValue = String(quantity);
    const readValue = () => quantityField.inputValue().catch(() => "?");

    // Attempt 1: type through the locator, character by character with a
    // real delay (some masked/custom inputs drop keystrokes sent too fast).
    await quantityField.pressSequentially(targetValue, { timeout: 10000, delay: 150 }).catch((err) => {
      console.log(`روش ۱ (pressSequentially) خطا داد: ${(err as Error).message}`);
    });
    console.log(`مقدار بعد از روش ۱: "${await readValue()}"`);

    // Attempt 2: same idea but through page.keyboard directly, in case the
    // locator-scoped key dispatch behaves differently than a real keyboard.
    if ((await readValue()) !== targetValue) {
      for (const digit of targetValue) {
        await page.keyboard.press(digit);
        await page.waitForTimeout(120);
      }
      console.log(`مقدار بعد از روش ۲ (page.keyboard): "${await readValue()}"`);
    }

    // Attempt 3: set .value via the native setter (bypasses any React-style
    // wrapper that shadows a plain assignment) and fire a fuller set of
    // events, including a synthetic keydown/keyup pair some libraries key
    // their internal state off of.
    if ((await readValue()) !== targetValue) {
      await quantityField.evaluate((el: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(el, value);
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      }, targetValue);
      console.log(`مقدار بعد از روش ۳ (JS setter): "${await readValue()}"`);
    }

    const finalValue = await readValue();
    if (finalValue !== targetValue) {
      console.log(`هشدار: بعد از هر سه روش، مقدار فیلد تعداد همچنان "${finalValue}" است، نه "${targetValue}".`);
    }

    await screenshotBestEffort(page, `AFTER_QUANTITY_${action}`);

    const submitLabel = action === "buy" ? "ارسال خرید" : "ارسال فروش";
    const submitButton = page.getByRole("button", { name: submitLabel });
    await submitButton.waitFor({ state: "visible", timeout: 10000 });
    await submitButton.click();

    // Some banners/toasts show briefly and are gone before the checks below
    // even start -- grab a quick snapshot right away too.
    await page.waitForTimeout(700);
    await screenshotBestEffort(page, `RIGHT_AFTER_SUBMIT_${action}`);

    // Submitting doesn't open a confirmation dialog -- the platform sends the
    // order straight to the exchange and shows either a success toast like
    // "در سبد خرید ثبت شد" or a rejection banner (confirmed for real: zero
    // balance shows "مانده کاربر کافی نیست"). Both are watched *concurrently*
    // and with the same short timeout -- waiting on the success toast alone
    // first used to let a dismissible error banner auto-hide before the
    // error check even started, silently losing the real reason.
    const toastPattern = action === "buy" ? /در سبد خرید ثبت شد/ : /در سبد فروش ثبت شد/;
    const knownErrors: Array<[RegExp, string]> = [
      [/مانده کاربر کافی نیست/, "موجودی/قدرت خرید حساب کافی نیست"],
      [/سقف (خرید|فروش)/, "سفارش از سقف مجاز خرید/فروش بیشتر است"],
    ];

    const successLocator = page.getByText(toastPattern);
    const errorLocators = knownErrors.map(([pattern]) => page.getByText(pattern));

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

export async function placeScheduledOrder(
  action: OrderAction,
  symbol: string,
  quantity: number
): Promise<OrderResult> {
  const startTime = Date.now();
  const browser: Browser = await chromium.launch({ headless: config.headless });
  try {
    // A default desktop viewport made the site serve its completely
    // different desktop layout (no bottom-nav "جستجو" tab at all) -- every
    // selector here was built from the mobile UI, so emulate a phone.
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();

    await login(page);
    await openSymbol(page, symbol);

    // Best-effort only: used purely to show an approximate Toman total in the
    // report, never to compute the quantity. A failed price read must not
    // block placing the order.
    const priceRial = await readLastPrice(page).catch(() => null);

    const { confirmed, errorReason } = await submitOrder(page, action, quantity);

    const approxTotal =
      priceRial !== null
        ? ` (≈ ${((quantity * priceRial) / 10).toLocaleString("fa-IR")} تومان)`
        : "";

    let message: string;
    if (confirmed) {
      message = `سفارش ${action === "buy" ? "خرید" : "فروش"} ${quantity} واحد ${symbol} ثبت شد${approxTotal}.`;
    } else if (errorReason) {
      message = `سفارش رد شد: ${errorReason}.`;
    } else {
      message =
        `دکمه‌ی ارسال زده شد ولی پیام «در سبد ${action === "buy" ? "خرید" : "فروش"} ثبت شد» دیده نشد -- ` +
        `اسکرین‌شات را چک کنید، ممکن است سفارش ثبت نشده باشد.`;
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
    await browser.close();
  }
}
