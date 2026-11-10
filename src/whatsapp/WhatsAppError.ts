import { XChannelSendFailure } from "@xpell/agent";

export const WHATSAPP_CHANNEL_ERROR_CODES = {
  INVALID_CONFIG: "E_WHATSAPP_CHANNEL_INVALID",
  NOT_READY: "E_WHATSAPP_CHANNEL_NOT_READY",
  BAD_UPDATE: "E_WHATSAPP_CHANNEL_BAD_UPDATE",
  BAD_MESSAGE: "E_WHATSAPP_CHANNEL_BAD_MESSAGE",
  PHONE_MISMATCH: "E_WHATSAPP_CHANNEL_PHONE_MISMATCH",
  WEBHOOK_UNAUTHORIZED: "E_WHATSAPP_WEBHOOK_UNAUTHORIZED",
  WEBHOOK_RAW_BODY_REQUIRED: "E_WHATSAPP_WEBHOOK_RAW_BODY_REQUIRED",
  WEBHOOK_TOO_LARGE: "E_WHATSAPP_WEBHOOK_TOO_LARGE",
  WEBHOOK_PROCESSING_FAILED: "E_WHATSAPP_WEBHOOK_PROCESSING_FAILED",
  SEND_REJECTED: "E_WHATSAPP_SEND_REJECTED",
  SEND_RATE_LIMITED: "E_WHATSAPP_SEND_RATE_LIMITED",
  SEND_UNCERTAIN: "E_WHATSAPP_SEND_UNCERTAIN",
} as const;

export type WhatsAppChannelErrorCode =
  (typeof WHATSAPP_CHANNEL_ERROR_CODES)[keyof typeof WHATSAPP_CHANNEL_ERROR_CODES];

/** Provider-safe error: never attach a token, payload, or raw response. */
export class WhatsAppChannelError extends XChannelSendFailure {
  readonly _code: WhatsAppChannelErrorCode;

  constructor(code: WhatsAppChannelErrorCode, message: string) {
    super(
      code === WHATSAPP_CHANNEL_ERROR_CODES.SEND_REJECTED ||
        code === WHATSAPP_CHANNEL_ERROR_CODES.BAD_MESSAGE
        ? "rejected"
        : code === WHATSAPP_CHANNEL_ERROR_CODES.SEND_RATE_LIMITED
          ? "rate_limited"
          : "unknown",
      message,
    );
    this.name = "WhatsAppChannelError";
    this._code = code;
  }
}

