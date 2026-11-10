import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  XChannel,
  XChannelInboundMessage,
  XChannelLifecycleStatus,
  XChannelOutboundMessage,
  XChannelRuntime,
  XChannelSendResult,
  XChannelStatusData,
} from "@xpell/agent";
import type { XWebRouteContributor } from "@xpell/node";

import {
  WhatsAppCloudApiClient,
  type WhatsAppFetch,
} from "./WhatsAppCloudApiClient.js";
import {
  WHATSAPP_CHANNEL_ERROR_CODES,
  WhatsAppChannelError,
} from "./WhatsAppError.js";
import {
  normalizeWhatsAppWebhook,
  type WhatsAppDeliveryStatus,
} from "./normalize.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NUMBER_ID_PATTERN = /^[0-9]{1,32}$/u;
const VERSION_PATTERN = /^v[0-9]{1,2}\.[0-9]{1,2}$/u;
const EXACT_ROUTE_PATTERN = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/u;
const MAX_WEBHOOK_BYTES = 256 * 1_024;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export type WhatsAppChannelConfig = {
  _id: string;
  _phone_number_id: string;
  _waba_id?: string;
  _access_token: string;
  _app_secret: string;
  _verify_token: string;
  _graph_api_version: string;
  _send_timeout_ms?: number;
};

export type WhatsAppChannelDependencies = {
  _fetch?: WhatsAppFetch;
  _now?: () => number;
  /** Status observations are provider events, never inbound Customer messages. */
  _on_delivery_status?: (status: WhatsAppDeliveryStatus) => void | Promise<void>;
  /** Exclusive opt-in. Resolve only after durable acceptance; reject on unknown/failed acceptance.
   * Uses the existing verifier/parser with a whole-input single-text policy. No direct receive/send.
   */
  _verified_text_handoff?: WhatsAppVerifiedTextHandoff;
};

export type WhatsAppVerifiedTextHandoff = (event: Readonly<{
  /** Construction-time configured locators, already matched by the existing normalizer. */
  _phone_number_id: string;
  _waba_id: string;
  _message: Readonly<XChannelInboundMessage>;
}>) => Promise<void>;

export type WhatsAppRouteOptions = { _path: string };

function safeSecretEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function readHeader(request: any, name: string): string | undefined {
  const fromGetter = typeof request?.get === "function"
    ? request.get(name)
    : undefined;
  if (typeof fromGetter === "string") return fromGetter;
  const value = request?.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function validRuntime(runtime: XChannelRuntime): boolean {
  return Boolean(runtime && typeof runtime.receive === "function");
}

function validateRoutePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !EXACT_ROUTE_PATTERN.test(path)) {
    throw new WhatsAppChannelError(
      WHATSAPP_CHANNEL_ERROR_CODES.INVALID_CONFIG,
      "WhatsApp webhook path must be an exact absolute route",
    );
  }
}

export function createWhatsAppWebhookPath(
  agentName: string,
  channelId: string,
): string {
  if (!ID_PATTERN.test(agentName) || !ID_PATTERN.test(channelId)) {
    throw new WhatsAppChannelError(
      WHATSAPP_CHANNEL_ERROR_CODES.INVALID_CONFIG,
      "WhatsApp webhook path identities must use lowercase kebab-case",
    );
  }
  return `/webhooks/whatsapp/${agentName}/${channelId}`;
}

/** Meta Cloud API text adapter. The host owns route registration and scope. */
export class WhatsAppChannel implements XChannel {
  readonly _id: string;
  readonly _provider = "whatsapp";

  readonly #phoneNumberId: string;
  readonly #wabaId?: string;
  readonly #accessToken: string;
  readonly #appSecret: string;
  readonly #verifyToken: string;
  readonly #graphApiVersion: string;
  readonly #sendTimeoutMs: number;
  readonly #fetch: WhatsAppFetch;
  readonly #now: () => number;
  readonly #onDeliveryStatus?: WhatsAppChannelDependencies["_on_delivery_status"];
  readonly #verifiedTextHandoff?: WhatsAppVerifiedTextHandoff;

  #status: XChannelLifecycleStatus = "registered";
  #error?: NonNullable<XChannelStatusData["_error"]>;
  #runtime?: XChannelRuntime;
  #client?: WhatsAppCloudApiClient;
  #startPromise?: Promise<void>;

  constructor(
    config: WhatsAppChannelConfig,
    dependencies: WhatsAppChannelDependencies = {},
  ) {
    this._id = config?._id;
    this.#phoneNumberId = config?._phone_number_id;
    this.#wabaId = config?._waba_id;
    this.#accessToken = config?._access_token;
    this.#appSecret = config?._app_secret;
    this.#verifyToken = config?._verify_token;
    this.#graphApiVersion = config?._graph_api_version;
    this.#sendTimeoutMs = config?._send_timeout_ms ?? DEFAULT_SEND_TIMEOUT_MS;
    this.#fetch = dependencies._fetch ?? fetch;
    this.#now = dependencies._now ?? Date.now;
    this.#onDeliveryStatus = dependencies._on_delivery_status;
    this.#verifiedTextHandoff = dependencies._verified_text_handoff;
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
        this.#client = new WhatsAppCloudApiClient({
          _phone_number_id: this.#phoneNumberId,
          _access_token: this.#accessToken,
          _graph_api_version: this.#graphApiVersion,
          _fetch: this.#fetch,
          _now: this.#now,
          _timeout_ms: this.#sendTimeoutMs,
        });
        this.#status = "ready";
      } catch {
        this.#runtime = undefined;
        this.#client = undefined;
        this.#status = "not_ready";
        this.#error = {
          _code: WHATSAPP_CHANNEL_ERROR_CODES.INVALID_CONFIG,
          _message: "WhatsApp Channel configuration is invalid",
        };
        throw new WhatsAppChannelError(
          WHATSAPP_CHANNEL_ERROR_CODES.INVALID_CONFIG,
          "WhatsApp Channel configuration is invalid",
        );
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
      ...(this.#error ? { _error: { ...this.#error } } : {}),
    };
  }

  async send(message: XChannelOutboundMessage): Promise<XChannelSendResult> {
    if (this.#status !== "ready" || this.#client === undefined) {
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.NOT_READY,
        "WhatsApp Channel is not ready",
      );
    }
    return await this.#client.sendMessage(message);
  }

  createRouteContributor(options: WhatsAppRouteOptions): XWebRouteContributor {
    validateRoutePath(options?._path);
    const path = options._path;
    return (app) => {
      app.get(path, (request, response) => {
        if (this.#status !== "ready") {
          response.set("retry-after", "1");
          response.status(503).json({
            _ok: false,
            _error: { _code: WHATSAPP_CHANNEL_ERROR_CODES.NOT_READY },
          });
          return;
        }
        const mode = request.query["hub.mode"];
        const token = request.query["hub.verify_token"];
        const challenge = request.query["hub.challenge"];
        if (mode !== "subscribe" ||
            !safeSecretEqual(token, this.#verifyToken) ||
            typeof challenge !== "string" || challenge.length === 0 ||
            challenge.length > 256) {
          response.status(403).json({
            _ok: false,
            _error: { _code: WHATSAPP_CHANNEL_ERROR_CODES.WEBHOOK_UNAUTHORIZED },
          });
          return;
        }
        response.status(200).send(challenge);
      });

      app.post(path, async (request, response) => {
        const rawBody = request.rawBody;
        if (!Buffer.isBuffer(rawBody)) {
          response.status(400).json({
            _ok: false,
            _error: { _code: WHATSAPP_CHANNEL_ERROR_CODES.WEBHOOK_RAW_BODY_REQUIRED },
          });
          return;
        }
        if (rawBody.length > MAX_WEBHOOK_BYTES) {
          response.status(413).json({
            _ok: false,
            _error: { _code: WHATSAPP_CHANNEL_ERROR_CODES.WEBHOOK_TOO_LARGE },
          });
          return;
        }
        const signature = readHeader(request, "x-hub-signature-256");
        if (!this.validSignature(signature, rawBody)) {
          response.status(401).json({
            _ok: false,
            _error: { _code: WHATSAPP_CHANNEL_ERROR_CODES.WEBHOOK_UNAUTHORIZED },
          });
          return;
        }
        if (this.#status !== "ready" || this.#runtime === undefined) {
          response.set("retry-after", "1");
          response.status(503).json({
            _ok: false,
            _error: { _code: WHATSAPP_CHANNEL_ERROR_CODES.NOT_READY },
          });
          return;
        }

        try {
          let signedPayload: unknown;
          try {
            signedPayload = JSON.parse(rawBody.toString("utf8"));
          } catch {
            throw new WhatsAppChannelError(
              WHATSAPP_CHANNEL_ERROR_CODES.BAD_UPDATE,
              "WhatsApp webhook payload is invalid",
            );
          }
          const events = normalizeWhatsAppWebhook(
            signedPayload,
            this.#phoneNumberId,
            this.#wabaId,
            this.#verifiedTextHandoff ? "single-text" : undefined,
          );
          if (this.#verifiedTextHandoff) {
            await this.#verifiedTextHandoff(Object.freeze({
              _phone_number_id: this.#phoneNumberId, _waba_id: this.#wabaId!,
              _message: Object.freeze({ ...events._messages[0] }),
            }));
          } else {
            for (const message of events._messages) {
              const result = await this.#runtime.receive(message);
              if (result?._ok !== true) {
                throw new WhatsAppChannelError(
                  WHATSAPP_CHANNEL_ERROR_CODES.WEBHOOK_PROCESSING_FAILED,
                  "WhatsApp inbound processing failed",
                );
              }
            }
          }
          if (this.#onDeliveryStatus) {
            for (const status of events._statuses) {
              await this.#onDeliveryStatus(status);
            }
          }
          response.status(200).json({
            _ok: true,
            ...(events._messages.length === 0 && events._statuses.length === 0
              ? { _ignored: true }
              : {}),
          });
        } catch (error) {
          const code = error instanceof WhatsAppChannelError
            ? error._code
            : WHATSAPP_CHANNEL_ERROR_CODES.WEBHOOK_PROCESSING_FAILED;
          const status = code === WHATSAPP_CHANNEL_ERROR_CODES.PHONE_MISMATCH
            ? 403
            : code === WHATSAPP_CHANNEL_ERROR_CODES.BAD_UPDATE
              ? 400
              : 502;
          response.status(status).json({ _ok: false, _error: { _code: code } });
        }
      });
    };
  }

  private validSignature(signature: unknown, body: Buffer): boolean {
    if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature) ||
        typeof this.#appSecret !== "string") {
      return false;
    }
    const received = Buffer.from(signature.slice(7), "hex");
    const expected = createHmac("sha256", this.#appSecret).update(body).digest();
    return timingSafeEqual(received, expected);
  }

  private validateConfiguration(runtime: XChannelRuntime): void {
    if (!ID_PATTERN.test(this._id) ||
        !NUMBER_ID_PATTERN.test(this.#phoneNumberId) ||
        (this.#wabaId !== undefined && !NUMBER_ID_PATTERN.test(this.#wabaId)) ||
        (this.#verifiedTextHandoff !== undefined &&
          (typeof this.#verifiedTextHandoff !== "function" || this.#wabaId === undefined)) ||
        typeof this.#accessToken !== "string" || this.#accessToken.length < 16 ||
        typeof this.#appSecret !== "string" || this.#appSecret.length < 16 ||
        typeof this.#verifyToken !== "string" || this.#verifyToken.length < 16 ||
        !VERSION_PATTERN.test(this.#graphApiVersion) ||
        !Number.isSafeInteger(this.#sendTimeoutMs) ||
        this.#sendTimeoutMs < 100 || this.#sendTimeoutMs > 60_000 ||
        !validRuntime(runtime)) {
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.INVALID_CONFIG,
        "WhatsApp Channel configuration is invalid",
      );
    }
  }
}
