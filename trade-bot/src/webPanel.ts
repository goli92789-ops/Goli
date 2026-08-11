import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { config } from "./config";
import { addJob, listAllJobs, ScheduledJob } from "./scheduler";

const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");

function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === config.panelUsername && pass === config.panelPassword) {
      next();
      return;
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Mesghal Bot"');
  res.status(401).send("دسترسی نیاز به ورود دارد.");
}

function nextOccurrence(hour: number, minute: number): Date {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function statusBadge(job: ScheduledJob): string {
  if (job.status === "pending") return `<span class="badge pending">در انتظار</span>`;
  if (job.status === "done") return `<span class="badge done">✅ انجام شد</span>`;
  return `<span class="badge failed">❌ ناموفق</span>`;
}

function renderPage(message: string | null): string {
  const jobs = listAllJobs();
  const rows = jobs
    .map((j) => {
      const fireAt = new Date(j.fireAt).toLocaleString("fa-IR");
      const screenshotLink = j.screenshotPath
        ? `<a href="/screenshots/${encodeURIComponent(path.basename(j.screenshotPath))}" target="_blank">مشاهده</a>`
        : "-";
      return `<tr>
        <td>${j.action === "buy" ? "خرید" : "فروش"}</td>
        <td>${j.symbol}</td>
        <td>${j.quantity}</td>
        <td>${fireAt}</td>
        <td>${statusBadge(j)}</td>
        <td>${j.resultMessage ?? "-"}</td>
        <td>${screenshotLink}</td>
      </tr>`;
    })
    .join("\n");

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
  button { margin-top: 16px; width: 100%; padding: 12px; background: #1e7a4c; color: white; border: none; border-radius: 6px; font-size: 1rem; }
  .message { background: #eaf7ee; border: 1px solid #1e7a4c; padding: 10px; border-radius: 6px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; background: white; border-radius: 10px; overflow: hidden; font-size: .85rem; }
  th, td { padding: 8px; border-bottom: 1px solid #eee; text-align: right; }
  th { background: #fafafa; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: .75rem; }
  .badge.pending { background: #fff3cd; color: #856404; }
  .badge.done { background: #d4edda; color: #155724; }
  .badge.failed { background: #f8d7da; color: #721c24; }
</style>
</head>
<body>
  <h1>سفارش زمان‌بندی‌شده</h1>
  ${message ? `<div class="message">${message}</div>` : ""}
  <form method="POST" action="/order">
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
      <tr><th>نوع</th><th>نماد</th><th>تعداد</th><th>زمان اجرا</th><th>وضعیت</th><th>پیام</th><th>اسکرین‌شات</th></tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="7">هنوز سفارشی ثبت نشده.</td></tr>`}
    </tbody>
  </table>
</body>
</html>`;
}

export function startWebPanel(): void {
  const app = express();
  app.use(basicAuth);
  app.use(express.urlencoded({ extended: false }));
  app.use("/screenshots", express.static(SCREENSHOT_DIR));

  app.get("/", (_req, res) => {
    res.send(renderPage(null));
  });

  app.post("/order", (req, res) => {
    const symbol = String(req.body.symbol ?? "").trim();
    const action = req.body.action === "sell" ? "sell" : "buy";
    const quantity = parseInt(req.body.quantity, 10);
    const time = String(req.body.time ?? "");
    const [hourStr, minuteStr] = time.split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (!symbol || !Number.isFinite(quantity) || quantity < 1 || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      res.status(400).send(renderPage("ورودی نامعتبر بود -- دوباره چک کنید."));
      return;
    }

    const fireAt = nextOccurrence(hour, minute);
    const job = addJob({ action, symbol, quantity, fireAt: fireAt.toISOString() });

    res.send(
      renderPage(
        `ثبت شد: ${action === "buy" ? "خرید" : "فروش"} ${quantity} واحد ${symbol} در ` +
          `${fireAt.toLocaleString("fa-IR")} (#${job.id})`
      )
    );
  });

  app.listen(config.panelPort, () => {
    console.log(`پنل روی پورت ${config.panelPort} روشن شد.`);
  });
}
