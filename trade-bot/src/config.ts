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
  panelUsername: required("PANEL_USERNAME"),
  panelPassword: required("PANEL_PASSWORD"),
  panelPort: parseInt(process.env.PANEL_PORT ?? "3000", 10),
  headless: process.env.HEADLESS !== "false",
};
