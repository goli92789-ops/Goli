import { startScheduler } from "./scheduler";
import { startWebPanel } from "./webPanel";
import { closeBrowser } from "./browserManager";
import { logger, setLogLevel } from "./logger";
import { config } from "./config";

setLogLevel(config.logLevel);

startScheduler();
startWebPanel();

logger.info("ربات روشن شد.");

/* ─── خاموشی تمیز ─── */

async function shutdown(signal: string): Promise<void> {
  logger.info(`سیگنال ${signal} دریافت شد -- خاموشی تمیز...`);

  try {
    await closeBrowser();
    logger.info("مرورگر بسته شد.");
  } catch (err) {
    logger.error(`خطا در بستن مرورگر: ${(err as Error).message}`);
  }

  logger.info("ربات خاموش شد.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  process.exit(1);
});
