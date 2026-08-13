import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import path from "path";
import { config } from "./config";
import { addJob, deleteJob, listAllJobs, ScheduledJob } from "./scheduler";
import { logger } from "./logger";

const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");

/* ─── helpers ─── */

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}

/* ─── احراز هویت ─── */

function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    try {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === config.panelUsername && pass === config.panelPassword) {
        next();
        return;
      }
    } catch { /* fall through */ }
  }
  res.set("WWW-Authenticate", 'Basic realm="Mesghal Bot"');
  res.status(401).send("دسترسی نیاز به ورود دارد.");
}

/* ─── محدودیت نرخ ─── */

const rateStore = new Map<string, { count: number; resetAt: number }>();

function rateLimit(maxReq: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateStore.get(ip);

    if (!entry || now > entry.resetAt) {
      rateStore.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;
    if (entry.count > maxReq) {
      logger.warn(`Rate limit از IP ${ip}`);
      res.status(429).send("تعداد درخواست‌ها بیش از حد مجاز.");
      return;
    }
    next();
  };
}

const postLimiter = rateLimit(20, 60_000);
const orderLimiter = rateLimit(10, 60_000);

/* ─── CSRF ─── */

function csrfGenerate(): string {
  return crypto.randomBytes(32).toString("hex");
}

function csrfVerify(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies["_csrf"];
  const bodyToken = req.body?._csrf;
  return !!cookieToken && !!bodyToken && cookieToken === bodyToken;
}

/* ─── زمان ─── */

function nextOccurrence(hour: number, minute: number): Date {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

/* ─── رندر HTML ─── */

function statusBadge(job: ScheduledJob): string {
  switch (job.status) {
    case "pending": return `<span class="badge pending">در انتظار</span>`;
    case "running": return `<span class="badge pending">⏳ در حال اجرا</span>`;
    case "done":    return `<span class="badge done">✅ انجام شد</span>`;
    default:        return `<span class="badge failed">❌ ناموفق</span>`;
  }
}

function screenshotLabel(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/^\d+_/, "").replace(/\.(png|html)$/, "") || base;
}

function renderPage(message: string | null, csrf: string): string {
  const jobs = listAllJobs();
  const rows = jobs.map((j) => {
    const fireAt = new Date(j.fireAt).toLocaleString("fa-IR");
    const screenshots = (j.screenshotPaths ?? [])
      .map(
        (p) =>
          `<a href="/screenshots/${encodeURIComponent(path.basename(p))}" target="_blank">${screenshotLabel(p)}</a>`
      )
      .join("<br/>") || "-";
    return `<tr>
      <td>${j.action === "buy" ? "خرید" : "فروش"}</td>
      <td>${j.symbol}</td>
      <td>${j.quantity}</td>
      <td>${fireAt}</td>
      <td>${statusBadge(j)}</td>
      <td>${j.resultMessage ?? "-"}</td>
      <td>${screenshots}</td>
      <td>
        <form method="POST" action="/order/${j.id}/delete" onsubmit="return confirm('حذف شود؟');">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <button type="submit" class="delete-btn">حذف</button>
        </form>
      </td>
    </tr>`;
  }).join("\n");

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>سفارش زمان‌بندی‌شده - مثقال</title>
<style>
  body { font-family: Tahoma, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 12px; background: #f5f5f7; color: #222; }
  h1 { font-size: 1.3rem; }
  form { background: white; padding: 16px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  label { display: block; margin-top: 12px; font-size: .9rem; color: #555; }
  input, select { width: 100%; box-sizing: border-box; padding: 10px; margin-top: 4px; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
  button { margin-top: 16px; width: 100%; padding: 12px; background: #1e7a4c; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #166b3e; }
  .message { background: #eaf7ee; border: 1px solid #1e7a4c; padding: 10px; border-radius: 6px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; background: white; border-radius: 10px; overflow: hidden; font-size: .85rem; }
  th, td { padding: 8px; border-bottom: 1px solid #eee; text-align: right; }
  th { background: #fafafa; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: .75rem; }
  .badge.pending { background: #fff3cd; color: #856404; }
  .badge.done { background: #d4edda; color: #155724; }
  .badge.failed { background: #f8d7da; color: #721c24; }
  td form { background: none; padding: 0; box-shadow: none; }
  .delete-btn { margin-top: 0; width: auto; padding: 6px 12px; background: #c0392b; font-size: .8rem; }
  .delete-btn:hover { background: #a93226; }
  .api-box { margin-top: 32px; padding: 16px; background: white; border-radius: 10px; font-size: .8rem; color: #666; }
  .api-box code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <h1>سفارش زمان‌بندی‌شده</h1>
  ${message ? `<div class="message">${message}</div>` : ""}
  <form method="POST" action="/order">
    <input type="hidden" name="_csrf" value="${csrf}" />
    <label>نماد
      <input type="text" name="symbol" value="مثقال" required />
    </label>
    <label>نوع سفارش
      <select name="action">
        <option value="buy">خرید</option>
        <option value="sell">فروش</option>
      </select>
    </label>
    <label>تعداد واحد
      <input type="number" name="quantity" min="1" step="1" required />
    </label>
    <label>ساعت اجرا (اگر گذشته باشد، فردا همین ساعت)
      <input type="time" name="time" required />
    </label>
    <button type="submit">زمان‌بندی کن</button>
  </form>

  <table>
    <thead>
      <tr><th>نوع</th><th>نماد</th><th>تعداد</th><th>زمان اجرا</th><th>وضعیت</th><th>پیام</th><th>اسکرین‌شات‌ها</th><th></th></tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="8">هنوز سفارشی ثبت نشده.</td></tr>`}
    </tbody>
  </table>

  <div class="api-box">
    <strong>REST API:</strong><br/>
    <code>GET /api/jobs</code> — لیست سفارش‌ها (JSON)<br/>
    <code>POST /api/order</code> — ثبت سفارش (JSON body: symbol, action, quantity, time)<br/>
    <code>DELETE /api/order/:id</code> — حذف سفارش
  </div>
</body>
</html>`;
}

/* ─── اپلیکیشن Express ─── */

export function startWebPanel(): void {
  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(basicAuth);
  app.use("/screenshots", express.static(SCREENSHOT_DIR));

  // ─── مسیرهای HTML ───

  app.get("/", (req, res) => {
    const message = typeof req.query.msg === "string" ? req.query.msg : null;
    const csrf = csrfGenerate();
    res.cookie("_csrf", csrf, { httpOnly: false, sameSite: "strict", path: "/" });
    res.send(renderPage(message, csrf));
  });

  app.get("/order", (_req, res) => res.redirect("/"));

  app.post("/order", postLimiter, orderLimiter, (req, res) => {
    if (!csrfVerify(req)) {
      res.status(403).send("درخواست نامعتبر (CSRF).");
      return;
    }

    const symbol = String(req.body.symbol ?? "").trim();
    const action = req.body.action === "sell" ? "sell" : "buy";
    const quantity = parseInt(req.body.quantity, 10);
    const [hourStr, minuteStr] = String(req.body.time ?? "").split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (!symbol || !Number.isFinite(quantity) || quantity < 1 || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      res.redirect("/?msg=" + encodeURIComponent("ورودی نامعتبر بود -- دوباره چک کنید."));
      return;
    }

    const fireAt = nextOccurrence(hour, minute);
    const job = addJob({ action, symbol, quantity, fireAt: fireAt.toISOString() });

    const msg =
      `ثبت شد: ${action === "buy" ? "خرید" : "فروش"} ${quantity} واحد ${symbol} در ` +
      `${fireAt.toLocaleString("fa-IR")} (#${job.id})`;
    res.redirect("/?msg=" + encodeURIComponent(msg));
  });

  app.post("/order/:id/delete", postLimiter, (req, res) => {
    if (!csrfVerify(req)) {
      res.status(403).send("درخواست نامعتبر (CSRF).");
      return;
    }
    const removed = deleteJob(req.params.id);
    const message = removed ? "سفارش حذف شد." : "سفارشی با این شناسه پیدا نشد.";
    res.redirect("/?msg=" + encodeURIComponent(message));
  });

  // ─── REST API (JSON) ───

  app.get("/api/jobs", (_req, res) => {
    res.json(listAllJobs());
  });

  app.post("/api/order", orderLimiter, (req, res) => {
    const { symbol, action, quantity, time } = req.body;
    const sym = String(symbol ?? "").trim();
    const act = action === "sell" ? "sell" : "buy";
    const qty = parseInt(quantity, 10);
    const [h, m] = String(time ?? "").split(":").map(Number);

    if (!sym || !Number.isFinite(qty) || qty < 1 || !Number.isFinite(h) || !Number.isFinite(m)) {
      res.status(400).json({ error: "ورودی نامعتبر." });
      return;
    }

    const fireAt = nextOccurrence(h, m);
    const job = addJob({ action: act, symbol: sym, quantity: qty, fireAt: fireAt.toISOString() });
    res.status(201).json(job);
  });

  app.delete("/api/order/:id", (req, res) => {
    const removed = deleteJob(req.params.id);
    if (removed) {
      res.json({ success: true, message: "سفارش حذف شد." });
    } else {
      res.status(404).json({ success: false, message: "سفارشی پیدا نشد." });
    }
  });

  app.listen(config.panelPort, () => {
    logger.info(`پنل وب روی پورت ${config.panelPort} روشن شد.`);
  });
    }
