import fs from "fs";
import path from "path";
import { placeScheduledOrder, OrderAction } from "./easytrader";

const DATA_DIR = path.join(__dirname, "..", "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const POLL_INTERVAL_MS = 15_000;

export interface ScheduledJob {
  id: string;
  chatId: number;
  action: OrderAction;
  symbol: string;
  amountToman: number;
  fireAt: string; // ISO timestamp
  status: "pending" | "done" | "failed";
  resultMessage?: string;
}

type ResultHandler = (job: ScheduledJob, screenshotPath: string) => void;

let jobs: ScheduledJob[] = [];
let resultHandler: ResultHandler | null = null;
let pollTimer: NodeJS.Timeout | null = null;

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

export function onJobResult(handler: ResultHandler): void {
  resultHandler = handler;
}

export function addJob(job: Omit<ScheduledJob, "id" | "status">): ScheduledJob {
  const full: ScheduledJob = {
    ...job,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    status: "pending",
  };
  jobs.push(full);
  saveJobs();
  return full;
}

export function listPendingJobs(chatId: number): ScheduledJob[] {
  return jobs.filter((j) => j.chatId === chatId && j.status === "pending");
}

async function runDueJobs(): Promise<void> {
  const now = Date.now();
  const due = jobs.filter((j) => j.status === "pending" && new Date(j.fireAt).getTime() <= now);

  for (const job of due) {
    const result = await placeScheduledOrder(job.action, job.symbol, job.amountToman);
    job.status = result.success ? "done" : "failed";
    job.resultMessage = result.message;
    saveJobs();
    resultHandler?.(job, result.screenshotPath);
  }
}

export function startScheduler(): void {
  loadJobs();
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    runDueJobs().catch((err) => console.error("خطای غیرمنتظره در زمان‌بند:", err));
  }, POLL_INTERVAL_MS);
}
