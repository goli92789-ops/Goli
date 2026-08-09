import TelegramBot from "node-telegram-bot-api";
import { config } from "./config";
import { addJob, listPendingJobs, onJobResult, ScheduledJob } from "./scheduler";
import { OrderAction } from "./easytrader";

const HELP_TEXT = `دستورها:

مثقال خرید 70 13:00
مثقال فروش 70 13:00

یعنی: نماد، بعد خرید یا فروش، بعد تعداد واحد، بعد ساعت (HH:MM، ساعت تهران).
اگر آن ساعت امروز گذشته باشد، برای فردا همان ساعت زمان‌بندی می‌شود.

/status -- فهرست سفارش‌های زمان‌بندی‌شده‌ی در انتظار`;

const COMMAND_PATTERN = /^(\S+)\s+(خرید|فروش)\s+(\d+)\s+(\d{1,2}):(\d{2})$/;

function isAuthorized(chatId: number): boolean {
  return String(chatId) === config.telegramAllowedChatId;
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

export function startTelegramBot(): TelegramBot {
  const bot = new TelegramBot(config.telegramBotToken, { polling: true });

  onJobResult((job: ScheduledJob, screenshotPath: string) => {
    const status = job.status === "done" ? "✅ انجام شد" : "❌ ناموفق";
    bot.sendMessage(job.chatId, `${status}\n${job.resultMessage ?? ""}`);
    if (screenshotPath) {
      bot.sendPhoto(job.chatId, screenshotPath).catch((err) => {
        console.error("ارسال اسکرین‌شات ناموفق بود:", err);
      });
    }
  });

  bot.on("message", (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();

    if (!isAuthorized(chatId)) {
      bot.sendMessage(chatId, "دسترسی مجاز نیست.");
      return;
    }

    if (text === "/start" || text === "/help") {
      bot.sendMessage(chatId, HELP_TEXT);
      return;
    }

    if (text === "/status") {
      const pending = listPendingJobs(chatId);
      if (pending.length === 0) {
        bot.sendMessage(chatId, "هیچ سفارش در انتظاری وجود ندارد.");
        return;
      }
      const lines = pending.map(
        (j) =>
          `#${j.id}: ${j.action === "buy" ? "خرید" : "فروش"} ${j.quantity} واحد ${j.symbol} ` +
          `در ${new Date(j.fireAt).toLocaleString("fa-IR")}`
      );
      bot.sendMessage(chatId, lines.join("\n"));
      return;
    }

    const match = text.match(COMMAND_PATTERN);
    if (!match) {
      bot.sendMessage(chatId, `دستور فهمیده نشد.\n\n${HELP_TEXT}`);
      return;
    }

    const [, symbol, actionWord, quantityStr, hourStr, minuteStr] = match;
    const action: OrderAction = actionWord === "خرید" ? "buy" : "sell";
    const quantity = parseInt(quantityStr, 10);
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (hour > 23 || minute > 59) {
      bot.sendMessage(chatId, "ساعت نامعتبر است.");
      return;
    }

    if (quantity < 1) {
      bot.sendMessage(chatId, "تعداد واحد باید حداقل ۱ باشد.");
      return;
    }

    const fireAt = nextOccurrence(hour, minute);
    const job = addJob({ chatId, action, symbol, quantity, fireAt: fireAt.toISOString() });

    bot.sendMessage(
      chatId,
      `ثبت شد (#${job.id}):\n` +
        `${action === "buy" ? "خرید" : "فروش"} ${quantity} واحد ${symbol}\n` +
        `زمان اجرا: ${fireAt.toLocaleString("fa-IR")}`
    );
  });

  return bot;
}
