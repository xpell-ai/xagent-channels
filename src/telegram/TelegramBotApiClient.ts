import type {
  XChannelOutboundMessage,
  XChannelSendResult,
} from "@xpell/agent";

import {
  TELEGRAM_CHANNEL_ERROR_CODES,
  TelegramChannelError,
} from "./TelegramError.js";
import type {
  TelegramApiResponse,
  TelegramSentMessage,
} from "./TelegramTypes.js";

export type TelegramFetch = typeof fetch;

function readReplyMessageId(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      "Telegram reply message ID must be a non-negative integer",
    );
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      "Telegram reply message ID is outside the supported integer range",
    );
  }
  return id;
}

function validateOutboundMessage(message: XChannelOutboundMessage): void {
  if (
    !message ||
    typeof message._external_conversation_id !== "string" ||
    message._external_conversation_id.length === 0 ||
    typeof message._text !== "string" ||
    message._text.length === 0
  ) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      "Telegram outbound message is invalid",
    );
  }
}

export class TelegramBotApiClient {
  readonly #botToken: string;
  readonly #fetch: TelegramFetch;
  readonly #now: () => number;

  constructor(botToken: string, fetchImpl: TelegramFetch, now: () => number) {
    this.#botToken = botToken;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async sendMessage(
    message: XChannelOutboundMessage,
  ): Promise<XChannelSendResult> {
    validateOutboundMessage(message);

    const payload: Record<string, unknown> = {
      chat_id: message._external_conversation_id,
      text: message._text,
    };
    if (message._reply_to_external_message_id !== undefined) {
      payload.reply_parameters = {
        message_id: readReplyMessageId(
          message._reply_to_external_message_id,
        ),
      };
    }

    try {
      const response = await this.#fetch(
        `https://api.telegram.org/bot${this.#botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        let retryAfter = response.status === 429
          ? Number(response.headers?.get?.("retry-after")) * 1000 : undefined;
        if (response.status === 429 &&
            (!Number.isSafeInteger(retryAfter) || retryAfter! <= 0)) {
          try {
            const body = (await response.json()) as TelegramApiResponse<TelegramSentMessage>;
            retryAfter = Number(body?.parameters?.retry_after) * 1000;
          } catch {
            retryAfter = undefined;
          }
        }
        throw new TelegramChannelError(
          TELEGRAM_CHANNEL_ERROR_CODES.SEND_FAILED,
          "Telegram did not accept the message",
          {},
          response.status === 429 ? "rate_limited" :
          response.status >= 400 && response.status < 500 && response.status !== 408
            ? "rejected" : "unknown",
          { _permanent: response.status >= 400 && response.status < 500 &&
              response.status !== 408 && response.status !== 429,
            ...(retryAfter !== undefined && Number.isSafeInteger(retryAfter) &&
              retryAfter > 0 ? { _retry_after_ms: retryAfter } : {}) },
        );
      }
      const body = (await response.json()) as TelegramApiResponse<TelegramSentMessage>;
      const messageId = body?.result?.message_id;

      if (body?.ok === false) {
        const code = body.error_code;
        const delay = Number(body.parameters?.retry_after) * 1000;
        throw new TelegramChannelError(
          TELEGRAM_CHANNEL_ERROR_CODES.SEND_FAILED,
          "Telegram did not accept the message",
          {},
          code === 429 ? "rate_limited" :
            typeof code === "number" && code >= 400 && code < 500 && code !== 408
              ? "rejected" : "unknown",
          { _permanent: typeof code === "number" && code >= 400 && code < 500 &&
              code !== 408 && code !== 429,
            ...(Number.isSafeInteger(delay) && delay > 0
              ? { _retry_after_ms: delay } : {}) },
        );
      }
      if (body?.ok !== true || typeof messageId !== "number" ||
          !Number.isSafeInteger(messageId)) {
        throw new TelegramChannelError(
          TELEGRAM_CHANNEL_ERROR_CODES.SEND_FAILED,
          "Telegram acceptance response was incomplete",
        );
      }

      return {
        _accepted: true,
        _external_message_id: String(messageId),
        _accepted_at: this.#now(),
      };
    } catch (error) {
      if (error instanceof TelegramChannelError) throw error;
      throw new TelegramChannelError(
        TELEGRAM_CHANNEL_ERROR_CODES.SEND_FAILED,
        "Telegram message delivery request failed",
      );
    }
  }
}
