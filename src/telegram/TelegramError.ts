import { XChannelSendFailure, type XChannelSendFailureCategory } from "@xpell/agent";

export const TELEGRAM_CHANNEL_ERROR_CODES = {
  INVALID_CONFIG: "E_TELEGRAM_CHANNEL_INVALID",
  NOT_READY: "E_TELEGRAM_CHANNEL_NOT_READY",
  BAD_UPDATE: "E_TELEGRAM_CHANNEL_BAD_UPDATE",
  BAD_MESSAGE: "E_TELEGRAM_CHANNEL_BAD_MESSAGE",
  SEND_FAILED: "E_TELEGRAM_CHANNEL_SEND_FAILED",
  WEBHOOK_UNAUTHORIZED: "E_TELEGRAM_WEBHOOK_UNAUTHORIZED",
  WEBHOOK_PROCESSING_FAILED: "E_TELEGRAM_WEBHOOK_PROCESSING_FAILED",
} as const;

export type TelegramChannelErrorCode =
  (typeof TELEGRAM_CHANNEL_ERROR_CODES)[keyof typeof TELEGRAM_CHANNEL_ERROR_CODES];

/** Safe provider error. It never includes tokens, secrets, or provider bodies. */
export class TelegramChannelError extends XChannelSendFailure {
  readonly _code: TelegramChannelErrorCode;
  readonly _details: Readonly<Record<string, unknown>>;

  constructor(
    code: TelegramChannelErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    category: XChannelSendFailureCategory = "unknown",
    options: Readonly<{ _retry_after_ms?: number; _permanent?: boolean }> = {},
  ) {
    super(category, message, options);
    this.name = "TelegramChannelError";
    this._code = code;
    this._details = Object.freeze({ ...details });
  }

  toXData() {
    return {
      _ok: false,
      _error: {
        _code: this._code,
        _message: this.message,
        _details: this._details,
      },
    };
  }
}

