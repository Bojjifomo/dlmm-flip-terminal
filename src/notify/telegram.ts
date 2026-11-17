import type { BotState, ManualAction } from "../domain";
import { log } from "../logger";

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id?: number } };
  };
}

export function telegramEnabled(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function notify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    log.info(`notify: ${text}`);
    return;
  }
  await call(token, "sendMessage", {
    chat_id: chat,
    text: text.slice(0, 3900),
    disable_web_page_preview: true,
  });
}

export async function notifyFlipAsk(position: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    log.info(`notify: ${text}\nkonfirmasi: meteora-flip confirm ${position}`);
    return;
  }
  await call(token, "sendMessage", {
    chat_id: chat,
    text: text.slice(0, 3900),
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Gas flip", callback_data: `c:${position}` },
          { text: "Skip", callback_data: `s:${position}` },
        ],
      ],
    },
  });
}

export async function notifyStaleAsk(position: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    log.info(`notify: ${text}`);
    return;
  }
  await call(token, "sendMessage", {
    chat_id: chat,
    text: text.slice(0, 3900),
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Hold", callback_data: `h:${position}` },
          { text: "Re-center", callback_data: `r:${position}` },
          { text: "Cut ke SOL", callback_data: `k:${position}` },
        ],
      ],
    },
  });
}

const STALE_ACTIONS: Record<string, ManualAction> = {
  h: "hold",
  r: "recenter",
  k: "cut",
};

export async function pollTelegram(state: BotState): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const offset = state.telegramOffset ? state.telegramOffset + 1 : undefined;
  const data = await call(token, "getUpdates", {
    offset,
    timeout: 0,
    allowed_updates: ["callback_query"],
  });
  const updates = (data.result ?? []) as TelegramUpdate[];
  for (const update of updates) {
    state.telegramOffset = update.update_id;
    const query = update.callback_query;
    if (!query?.data) continue;
    if (String(query.message?.chat?.id ?? "") !== String(chat)) continue;
    const [action, position] = query.data.split(":");
    if (!position) continue;
    if (action === "c") state.manual[position] = "confirm";
    if (action === "s") state.manual[position] = "skip";
    const stale = STALE_ACTIONS[action];
    if (stale) state.manual[position] = stale;
    await call(token, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: stale ? stale : action === "c" ? "Oke, gue jalanin" : "Di-skip",
    }).catch(() => undefined);
  }
}

async function call(token: string, method: string, body: Record<string, unknown>): Promise<{ result?: unknown }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: boolean; description?: string; result?: unknown };
  if (!res.ok || json.ok === false) {
    throw new Error(`Telegram ${method} gagal: ${json.description ?? res.status}`);
  }
  return json;
}

export async function notifyError(state: BotState, key: string, text: string, nowMs: number): Promise<void> {
  const last = state.notifiedErrors[key] ?? 0;
  if (nowMs - last < 10 * 60_000) return;
  state.notifiedErrors[key] = nowMs;
  try {
    await notify(text);
  } catch (error) {
    log.warn(`telegram error: ${error instanceof Error ? error.message : error}`);
  }
}
