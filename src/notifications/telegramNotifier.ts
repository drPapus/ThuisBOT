import { logger } from "../utils/logger.js";

export interface TelegramNotifierConfig {
  token?: string | undefined;
  chatId?: string | undefined;
}

export function loadTelegramNotifierConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramNotifierConfig {
  return {
    token: environment.TELEGRAM_BOT_TOKEN?.trim(),
    chatId: environment.TELEGRAM_CHAT_ID?.trim(),
  };
}

export async function sendTelegramNotification(
  text: string,
  config: TelegramNotifierConfig = loadTelegramNotifierConfig(),
): Promise<boolean> {
  if (!config.token || !config.chatId) {
    logger.error("Telegram notification skipped: configuration is missing.");
    return false;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
        }),
      },
    );

    if (!response.ok) {
      logger.error(
        `Telegram notification failed with HTTP ${response.status}.`,
      );
      return false;
    }

    const result = (await response.json()) as { ok?: boolean };

    if (result.ok !== true) {
      logger.error("Telegram notification was rejected by Telegram.");
      return false;
    }

    logger.info("Telegram notification sent.");
    return true;
  } catch (error: unknown) {
    logger.error(
      `Telegram notification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
