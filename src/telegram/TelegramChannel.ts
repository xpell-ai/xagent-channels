import { createHash, timingSafeEqual } from "node:crypto";

import type {
  XChannel,
  XChannelLifecycleStatus,
  XChannelOutboundMessage,
  XChannelRuntime,
  XChannelSendResult,
  XChannelStatusData,
} from "@xpell/agent";
import type { XWebRouteContributor } from "@xpell/node";

import {
  TelegramBotApiClient,
  type TelegramFetch,
} from "./TelegramBotApiClient.js";
import {
  TELEGRAM_CHANNEL_ERROR_CODES,
  TelegramChannelError,
} from "./TelegramError.js";
import { normalizeTelegramUpdate } from "./normalize.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BOT_TOKEN_PATTERN = /^[0-9]+:[A-Za-z0-9_-]{20,}$/u;
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const EXACT_ROUTE_PATTERN = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export type TelegramChannelConfig = {
  _id: string;
  _bot_token: string;
  _webhook_secret: string;
};

export type TelegramChannelDependencies = {
  _fetch?: TelegramFetch;
  _now?: () => number;
};

export type TelegramRouteOptions = {
  _path: string;
};

type SafeStatusError = NonNullable<XChannelStatusData["_error"]>;

function validRuntime(runtime: XChannelRuntime): boolean {
  return Boolean(runtime && typeof runtime.receive === "function");
}

function safeSecretEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function readHeader(request: any, name: string): string | undefined {
  const fromGetter =
    typeof request?.get === "function" ? request.get(name) : undefined;
  if (typeof fromGetter === "string") return fromGetter;
  const value = request?.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function validateRoutePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !EXACT_ROUTE_PATTERN.test(path)) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.INVALID_CONFIG,
      "Telegram webhook path must be an exact absolute route",
    );
  }
}

/** Build the documented host-owned route convention without registering it. */
export function createTelegramWebhookPath(
  agentName: string,
  channelId: string,
): string {
  if (!ID_PATTERN.test(agentName) || !ID_PATTERN.test(channelId)) {
    throw new TelegramChannelError(
      TELEGRAM_CHANNEL_ERROR_CODES.INVALID_CONFIG,
      "Telegram webhook path identities must use lowercase kebab-case",
    );
  }
  return `/webhooks/telegram/${agentName}/${channelId}`;
}

/** Webhook-only Telegram text adapter owned by one XAgent. */
export class TelegramChannel implements XChannel {
  readonly _id: string;
  readonly _provider = "telegram";

  readonly #botToken: string;
  readonly #webhookSecret: string;
  readonly #fetch: TelegramFetch;
  readonly #now: () => number;

  #status: XChannelLifecycleStatus = "registered";
  #error?: SafeStatusError;
  #runtime?: XChannelRuntime;
  #client?: TelegramBotApiClient;
  #startPromise?: Promise<void>;

  constructor(
    config: TelegramChannelConfig,
    dependencies: TelegramChannelDependencies = {},
  ) {
    this._id = config?._id;
    this.#botToken = config?._bot_token;
    this.#webhookSecret = config?._webhook_secret;
    this.#fetch = dependencies._fetch ?? fetch;
    this.#now = dependencies._now ?? Date.now;
  }

  start(runtime: XChannelRuntime): Promise<void> {
    if (this.#status === "ready") return Promise.resolve();
    if (this.#startPromise !== undefined) return this.#startPromise;

    this.#status = "starting";
    this.#error = undefined;
    this.#startPromise = Promise.resolve().then(() => {
      try {
        this.validateConfiguration(runtime);
        this.#runtime = runtime;
        this.#client = new TelegramBotApiClient(
          this.#botToken,
          this.#fetch,
          this.#now,
        );
        this.#status = "ready";
      } catch (error) {
        this.#runtime = undefined;
        this.#client = undefined;
        this.#status = "not_ready";
        const code =
          error instanceof TelegramChannelError
            ? error._code
            : TELEGRAM_CHANNEL_ERROR_CODES.INVALID_CONFIG;
        this.#error = {
          _code: code,
          _message: "Telegram Channel configuration is invalid",
        };
        throw error;
      }
    });
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    if (this.#status === "stopped") return;
    this.#runtime = undefined;
    this.#client = undefined;
    this.#status = "stopped";
    this.#error = undefined;
  }

  getStatus(): XChannelStatusData {
    return {
      _id: this._id,
      _provider: this._provider,
      _status: this.#status,
      _ready: this.#status === "ready",
      ...(this.#error !== undefined ? { _error: { ...this.#error } } : {}),
    };
  }

  async send(
    message: XChannelOutboundMessage,
  ): Promise<XChannelSendResult> {
    if (this.#status !== "ready" || this.#client === undefined) {
      throw new TelegramChannelError(
        TELEGRAM_CHANNEL_ERROR_CODES.NOT_READY,
        `Telegram Channel '${this._id}' is not ready`,
        { _channel_id: this._id },
      );
    }
    return await this.#client.sendMessage(message);
  }

  /** Telegram permits a bot to retry a verified existing conversation reply. */
  authorizeRecovery(message: Readonly<XChannelOutboundMessage>): boolean {
    return this.#status === "ready" &&
      typeof message._external_conversation_id === "string" &&
      message._external_conversation_id.length > 0 &&
      typeof message._text === "string" && message._text.length > 0 &&
      (message._reply_to_external_message_id === undefined ||
        (/^(?:0|[1-9][0-9]*)$/u.test(message._reply_to_external_message_id) &&
          Number.isSafeInteger(Number(message._reply_to_external_message_id))));
  }

  /**
   * Create a pre-start XNode route contributor. The host owns the exact path;
   * this adapter owns POST handling, Telegram verification, and normalization.
   */
  createRouteContributor(options: TelegramRouteOptions): XWebRouteContributor {
    validateRoutePath(options?._path);
    const routePath = options._path;

    return (app) => {
      app.post(routePath, async (request, response) => {
        if (
          !safeSecretEqual(
            readHeader(request, SECRET_HEADER),
            this.#webhookSecret,
          )
        ) {
          response.status(401).json({
            _ok: false,
            _error: {
              _code: TELEGRAM_CHANNEL_ERROR_CODES.WEBHOOK_UNAUTHORIZED,
            },
          });
          return;
        }

        if (this.#status !== "ready" || this.#runtime === undefined) {
          response.set("retry-after", "1");
          response.status(503).json({
            _ok: false,
            _error: { _code: TELEGRAM_CHANNEL_ERROR_CODES.NOT_READY },
          });
          return;
        }

        try {
          const message = normalizeTelegramUpdate(request.body);
          if (message === undefined) {
            response.status(200).json({ _ok: true, _ignored: true });
            return;
          }

          const result = await this.#runtime.receive(message);
          if (result?._ok !== true) {
            response.status(502).json({
              _ok: false,
              _error: {
                _code: TELEGRAM_CHANNEL_ERROR_CODES.WEBHOOK_PROCESSING_FAILED,
              },
            });
            return;
          }

          response.status(200).json({ _ok: true });
        } catch (error) {
          const status =
            error instanceof TelegramChannelError &&
            error._code === TELEGRAM_CHANNEL_ERROR_CODES.BAD_UPDATE
              ? 400
              : 500;
          response.status(status).json({
            _ok: false,
            _error: {
              _code:
                status === 400
                  ? TELEGRAM_CHANNEL_ERROR_CODES.BAD_UPDATE
                  : TELEGRAM_CHANNEL_ERROR_CODES.WEBHOOK_PROCESSING_FAILED,
            },
          });
        }
      });
    };
  }

  private validateConfiguration(runtime: XChannelRuntime): void {
    if (
      !ID_PATTERN.test(this._id) ||
      !BOT_TOKEN_PATTERN.test(this.#botToken) ||
      !WEBHOOK_SECRET_PATTERN.test(this.#webhookSecret) ||
      !validRuntime(runtime)
    ) {
      throw new TelegramChannelError(
        TELEGRAM_CHANNEL_ERROR_CODES.INVALID_CONFIG,
        "Telegram Channel configuration is invalid",
        { _channel_id: ID_PATTERN.test(this._id) ? this._id : null },
      );
    }
  }
}
