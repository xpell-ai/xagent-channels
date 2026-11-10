import type { XChannelInboundMessage } from "@xpell/agent";

import {
  TELEGRAM_CHANNEL_ERROR_CODES,
  TelegramChannelError,
} from "./TelegramError.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, field: string): JsonObject {
  if (!isObject(value)) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.BAD_UPDATE,
      `Invalid Telegram update field '${field}'`,
    );
  }
  return value;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.BAD_UPDATE,
      `Invalid Telegram update field '${field}'`,
    );
  }
  return String(value);
}

function readTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.BAD_UPDATE,
      "Invalid Telegram update field 'message.date'",
    );
  }
  return value * 1_000;
}

/**
 * Normalize one supported Telegram text update. Unsupported update kinds and
 * non-text messages return undefined so the webhook can acknowledge them.
 */
export function normalizeTelegramUpdate(
  input: unknown,
): XChannelInboundMessage | undefined {
  const update = requireObject(input, "update");
  requireId(update.update_id, "update_id");

  if (update.message === undefined) return undefined;
  const message = requireObject(update.message, "message");
  if (message.text === undefined) return undefined;
  if (typeof message.text !== "string" || message.text.length === 0) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.BAD_UPDATE,
      "Invalid Telegram update field 'message.text'",
    );
  }

  const from = requireObject(message.from, "message.from");
  const chat = requireObject(message.chat, "message.chat");
  const timestamp = readTimestamp(message.date);

  let replyTo: string | undefined;
  if (message.reply_to_message !== undefined) {
    const reply = requireObject(
      message.reply_to_message,
      "message.reply_to_message",
    );
    replyTo = requireId(
      reply.message_id,
      "message.reply_to_message.message_id",
    );
  }

  return {
    _external_user_id: requireId(from.id, "message.from.id"),
    _external_conversation_id: requireId(chat.id, "message.chat.id"),
    _external_message_id: requireId(message.message_id, "message.message_id"),
    _text: message.text,
    ...(timestamp !== undefined ? { _timestamp: timestamp } : {}),
    ...(replyTo !== undefined
      ? { _reply_to_external_message_id: replyTo }
      : {}),
  };
}
