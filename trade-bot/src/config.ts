import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`متغیر محیطی ${name} تنظیم نشده (فایل .env را چک کنید)`);
  }
  return value;
}

export const config = {
  mofidUsername: required("MOFID_USERNAME"),
  mofidPassword: required("MOFID_PASSWORD"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramAllowedChatId: required("TELEGRAM_ALLOWED_CHAT_ID"),
  headless: process.env.HEADLESS !== "false",
};
