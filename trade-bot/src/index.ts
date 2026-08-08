import { startScheduler } from "./scheduler";
import { startTelegramBot } from "./telegramBot";

startScheduler();
startTelegramBot();

console.log("ربات روشن شد و منتظر دستور در تلگرام است.");
