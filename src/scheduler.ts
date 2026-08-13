import fs from "fs";
import path from "path";
import { placeScheduledOrder, OrderAction } from "./easytrader";
import { logger } from "./logger";

const DATA_DIR = path.join(__dirname, "..", "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");
const POLL_INTERVAL_MS = 15_000;
const SCREENSHOT_MAX_AGE_DAYS = 7;

export interface ScheduledJob {
  id: string;
  action: OrderAction;
  symbol: string;
  quantity: number;
  fireAt: string;
  createdAt: string;
  status: "pending" | "running" | "done" | "failed";
  resultMessage?: string;
  screenshotPaths?: string[];
  retryCount: number;
  maxRetries: number;
  lastRetryAt?: string;
}

let jobs: ScheduledJob[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let pollInProgress = false;

/* ─── ذخیره‌سازی اتمیک ─── */

function loadJobs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(JOBS_FILE)) {
    try {
      jobs = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
    } catch {
      logger.error("فایل jobs.json خراب است -- با لیست خالی شروع می‌شود.");
      jobs = [];
    }
  }
}

function saveJobs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = JOBS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, JOBS_FILE);
}

/* ─── CRUD ─── */

export function addJob(job: Pick<ScheduledJob, "action" | "symbol" | "quantity" | "fireAt">): ScheduledJob {
  const full: ScheduledJob = {
    ...job,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    status: "pending",
    retryCount: 0,
    maxRetries: 2,
  };
  jobs.push(full);
  saveJobs();
  logger.info(`سفارش جدید: ${full.action} ${full.quantity} ${full.symbol} (#${full.id})`);
  return full;
}

export function listAllJobs(): ScheduledJob[] {
  return [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteJob(id: string): boolean {
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  if (jobs.length !== before) {
    saveJobs();
    logger.info(`سفارش #${id} حذف شد.`);
    return true;
  }
  return false;
}

/* ─── پاکسازی اسکرین‌شات‌های قدیمی ─── */

export function cleanupOldScreenshots(): void {
  if (!fs.existsSync(SCREENSHOT_DIR)) return;
  const cutoff = Date.now() - SCREENSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const file of fs.readdirSync(SCREENSHOT_DIR)) {
    const match = file.match(/^(\d+)_/);
    if (match && parseInt(match[1], 10) < cutoff) {
      fs.unlinkSync(path.join(SCREENSHOT_DIR, file));
      deleted++;
    }
  }
  if (deleted > 0) logger.info(`${deleted} اسکرین‌شات قدیمی پاک شد.`);
}

/* ─── اجرای سفارش‌ها (با retry) ─── */

async function runDueJobs(): Promise<void> {
  const now = Date.now();
  const due = jobs.filter((j) => j.status === "pending" && new Date(j.fireAt).getTime() <= now);

  for (const job of due) {
    job.status = "running";
    saveJobs();
    logger.info(`اجرای سفارش #${job.id}: ${job.action} ${job.quantity} ${job.symbol}`);

    const result = await placeScheduledOrder(job.action, job.symbol, job.quantity);

    if (result.success) {
      job.status = "done";
      job.resultMessage = result.message;
      logger.info(`سفارش #${job.id} موفق.`);
    } else {
      job.retryCount += 1;

      if (job.retryCount < job.maxRetries) {
        job.status = "pending";
        job.fireAt = new Date(Date.now() + 60_000).toISOString();
        job.lastRetryAt = new Date().toISOString();
        job.resultMessage = `تلاش ${job.retryCount}/${job.maxRetries} ناموفق: ${result.message}. تلاش مجدد...`;
        logger.warn(`سفارش #${job.id} ناموفق (تلاش ${job.retryCount}): ${result.message}`);
      } else {
        job.status = "failed";
        job.resultMessage = `بعد از ${job.retryCount} تلاش ناموفق: ${result.message}`;
        logger.error(`سفارش #${job.id} failed نهایی.`);
      }
    }

    job.screenshotPaths = result.screenshotPaths;
    saveJobs();
  }
}

/* ─── شروع زمان‌بند ─── */

export function startScheduler(): void {
  loadJobs();

  jobs.filter((j) => j.status === "running").forEach((j) => {
    j.status = "pending";
    logger.warn(`سفارش #${j.id} در وضعیت running بود -- به pending برگشت.`);
  });
  saveJobs();

  cleanupOldScreenshots();
  setInterval(cleanupOldScreenshots, 24 * 60 * 60 * 1000);

  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (pollInProgress) return;
    pollInProgress = true;
    runDueJobs()
      .catch((err) => logger.error(`خطای زمان‌بند: ${(err as Error).message}`))
      .finally(() => {
        pollInProgress = false;
      });
  }, POLL_INTERVAL_MS);

  logger.info(`زمان‌بند فعال شد (هر ${POLL_INTERVAL_MS / 1000}s).`);
}
