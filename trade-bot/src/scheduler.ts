import fs from "fs";
import path from "path";
import { placeScheduledOrder, OrderAction } from "./easytrader";

const DATA_DIR = path.join(__dirname, "..", "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const POLL_INTERVAL_MS = 15_000;

export interface ScheduledJob {
  id: string;
  action: OrderAction;
  symbol: string;
  quantity: number;
  fireAt: string; // ISO timestamp
  createdAt: string; // ISO timestamp
  status: "pending" | "running" | "done" | "failed";
  resultMessage?: string;
  screenshotPath?: string;
}

let jobs: ScheduledJob[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let pollInProgress = false;

function loadJobs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(JOBS_FILE)) {
    jobs = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
  }
}

function saveJobs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

export function addJob(job: Pick<ScheduledJob, "action" | "symbol" | "quantity" | "fireAt">): ScheduledJob {
  const full: ScheduledJob = {
    ...job,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  jobs.push(full);
  saveJobs();
  return full;
}

/** Newest first, for the panel's history table. */
export function listAllJobs(): ScheduledJob[] {
  return [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function runDueJobs(): Promise<void> {
  const now = Date.now();
  const due = jobs.filter((j) => j.status === "pending" && new Date(j.fireAt).getTime() <= now);

  for (const job of due) {
    // Claimed and persisted *before* the (slow) browser automation starts,
    // so an overlapping poll tick can never pick up the same job twice.
    job.status = "running";
    saveJobs();

    const result = await placeScheduledOrder(job.action, job.symbol, job.quantity);
    job.status = result.success ? "done" : "failed";
    job.resultMessage = result.message;
    job.screenshotPath = result.screenshotPath;
    saveJobs();
  }
}

export function startScheduler(): void {
  loadJobs();
  // A run that includes launching a browser and waiting on page loads can
  // easily take longer than POLL_INTERVAL_MS -- this guard stops a slow tick
  // from overlapping with the next one, which used to launch a second
  // concurrent Chromium instance competing for the same CPU/memory.
  jobs.filter((j) => j.status === "running").forEach((j) => {
    j.status = "pending";
  });
  saveJobs();

  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (pollInProgress) return;
    pollInProgress = true;
    runDueJobs()
      .catch((err) => console.error("خطای غیرمنتظره در زمان‌بند:", err))
      .finally(() => {
        pollInProgress = false;
      });
  }, POLL_INTERVAL_MS);
}
