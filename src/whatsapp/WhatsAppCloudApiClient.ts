import type {
  XChannelOutboundMessage,
  XChannelSendResult,
} from "@xpell/agent";

import {
  WHATSAPP_CHANNEL_ERROR_CODES,
  WhatsAppChannelError,
} from "./WhatsAppError.js";

const PHONE_ID = /^[0-9]{1,32}$/u;
const EXTERNAL_ID = /^[A-Za-z0-9._~:/+=-]{1,512}$/u;

export type WhatsAppFetch = typeof fetch;

async function readMetaErrorCodes(response: Response): Promise<{
  _meta_error_code?: number;
  _meta_error_subcode?: number;
}> {
  try {
    const payload = await response.json() as { error?: {
      code?: unknown;
      error_subcode?: unknown;
    } };
    const error = payload?.error;
    return {
      ...(Number.isSafeInteger(error?.code) && Number(error?.code) >= 0
        ? { _meta_error_code: error!.code as number } : {}),
      ...(Number.isSafeInteger(error?.error_subcode) &&
        Number(error?.error_subcode) >= 0
        ? { _meta_error_subcode: error!.error_subcode as number } : {}),
    };
  } catch {
    return {};
  }
}

function logSendFailure(
  source: "http_response" | "transport" | "invalid_acceptance",
  code: string,
  status?: number,
  metaCodes: { _meta_error_code?: number; _meta_error_subcode?: number } = {},
): void {
  const category = code === WHATSAPP_CHANNEL_ERROR_CODES.SEND_REJECTED
    ? "rejected"
    : code === WHATSAPP_CHANNEL_ERROR_CODES.SEND_RATE_LIMITED
      ? "rate_limited" : "unknown";
  try {
    console.warn("[whatsapp] send failed", {
      _source: source,
      _code: code,
      ...(status !== undefined ? { _http_status: status } : {}),
      ...metaCodes,
      _category: category,
      // Mirrors current recovery eligibility; this log does not change it.
      _retryable: category === "rejected" || category === "rate_limited",
    });
  } catch {
    // Diagnostics must never change the send failure observed by XAgent.
  }
}

function validateMessage(message: XChannelOutboundMessage): void {
  if (!message ||
      typeof message._external_conversation_id !== "string" ||
      !PHONE_ID.test(message._external_conversation_id) ||
      typeof message._text !== "string" ||
      message._text.length === 0 || message._text.length > 4_096 ||
      (message._reply_to_external_message_id !== undefined &&
        !EXTERNAL_ID.test(message._reply_to_external_message_id))) {
    throw new WhatsAppChannelError(
      WHATSAPP_CHANNEL_ERROR_CODES.BAD_MESSAGE,
      "WhatsApp outbound text message is invalid",
    );
  }
}

/** A single request. Unknown outcomes are surfaced, never retried here. */
export class WhatsAppCloudApiClient {
  readonly #phoneNumberId: string;
  readonly #accessToken: string;
  readonly #graphApiVersion: string;
  readonly #fetch: WhatsAppFetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(options: {
    _phone_number_id: string;
    _access_token: string;
    _graph_api_version: string;
    _fetch: WhatsAppFetch;
    _now: () => number;
    _timeout_ms: number;
  }) {
    this.#phoneNumberId = options._phone_number_id;
    this.#accessToken = options._access_token;
    this.#graphApiVersion = options._graph_api_version;
    this.#fetch = options._fetch;
    this.#now = options._now;
    this.#timeoutMs = options._timeout_ms;
  }

  async sendMessage(
    message: XChannelOutboundMessage,
  ): Promise<XChannelSendResult> {
    validateMessage(message);
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: message._external_conversation_id,
      type: "text",
      text: { preview_url: false, body: message._text },
      ...(message._reply_to_external_message_id !== undefined
        ? { context: { message_id: message._reply_to_external_message_id } }
        : {}),
    };

    let response: Response;
    try {
      response = await this.#fetch(
        `https://graph.facebook.com/${this.#graphApiVersion}/${this.#phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      logSendFailure("transport", WHATSAPP_CHANNEL_ERROR_CODES.SEND_UNCERTAIN);
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.SEND_UNCERTAIN,
        "WhatsApp send outcome is unknown; reconcile before retrying",
      );
    }

    if (!response.ok) {
      const code = response.status === 429
        ? WHATSAPP_CHANNEL_ERROR_CODES.SEND_RATE_LIMITED
        : response.status >= 500
          ? WHATSAPP_CHANNEL_ERROR_CODES.SEND_UNCERTAIN
          : WHATSAPP_CHANNEL_ERROR_CODES.SEND_REJECTED;
      logSendFailure("http_response", code, response.status,
        await readMetaErrorCodes(response));
    }
    if (response.status === 429) {
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.SEND_RATE_LIMITED,
        "WhatsApp rate limited the send request",
      );
    }
    if (response.status >= 500) {
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.SEND_UNCERTAIN,
        "WhatsApp send outcome is unknown; reconcile before retrying",
      );
    }
    if (!response.ok) {
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.SEND_REJECTED,
        "WhatsApp rejected the send request",
      );
    }

    try {
      const payload = await response.json() as {
        messaging_product?: unknown;
        messages?: unknown;
      };
      const first = Array.isArray(payload?.messages) ? payload.messages[0] : undefined;
      const id = first?.id;
      if (payload?.messaging_product !== "whatsapp" ||
          typeof id !== "string" || !EXTERNAL_ID.test(id)) {
        throw new Error("Invalid acceptance response");
      }
      return {
        _accepted: true,
        _external_message_id: id,
        _accepted_at: this.#now(),
      };
    } catch {
      logSendFailure("invalid_acceptance",
        WHATSAPP_CHANNEL_ERROR_CODES.SEND_UNCERTAIN, response.status);
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.SEND_UNCERTAIN,
        "WhatsApp send outcome is unknown; reconcile before retrying",
      );
    }
  }
}
