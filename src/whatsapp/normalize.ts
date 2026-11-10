import type { XChannelInboundMessage } from "@xpell/agent";

import {
  WHATSAPP_CHANNEL_ERROR_CODES,
  WhatsAppChannelError,
} from "./WhatsAppError.js";

type JsonObject = Record<string, unknown>;

export type WhatsAppDeliveryStatus = Readonly<{
  _external_message_id: string;
  _recipient_id: string;
  _status: "sent" | "delivered" | "read" | "failed";
  _timestamp?: number;
}>;

export type WhatsAppWebhookEvents = Readonly<{
  _messages: readonly XChannelInboundMessage[];
  _statuses: readonly WhatsAppDeliveryStatus[];
}>;

/** Opt-in whole-input subset for a single durable handoff; default parsing is unchanged. */
export type WhatsAppWebhookPolicy = "single-text";

const MAX_ENTRIES = 16;
const MAX_CHANGES = 32;
const MAX_EVENTS = 100;
const EXTERNAL_ID = /^[A-Za-z0-9._~:/+=-]{1,512}$/u;
const PHONE_ID = /^[0-9]{1,32}$/u;

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function invalid(): never {
  throw new WhatsAppChannelError(
    WHATSAPP_CHANNEL_ERROR_CODES.BAD_UPDATE,
    "WhatsApp webhook payload is invalid",
  );
}

function boundedArray(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}

function externalId(value: unknown): string {
  if (typeof value !== "string" || !EXTERNAL_ID.test(value)) invalid();
  return value;
}

function phoneId(value: unknown): string {
  if (typeof value !== "string" || !PHONE_ID.test(value)) invalid();
  return value;
}

function timestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]{1,12}$/u.test(value)) invalid();
  const milliseconds = Number(value) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) invalid();
  return milliseconds;
}

function onlyKeys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}

// This validates cardinality/unsupported input before the existing parser emits anything.
// It is not another normalizer: IDs, text, timestamps and replies use the common path below.
function singleTextInput(root: JsonObject, entries: readonly unknown[], waba?: string): void {
  if (waba === undefined || entries.length !== 1) invalid();
  onlyKeys(root, ["object", "entry"]);
  const entry = record(entries[0]);
  if (!entry) invalid();
  onlyKeys(entry, ["id", "changes"]);
  const changes = boundedArray(entry.changes, 1);
  const change = record(changes[0]);
  if (changes.length !== 1 || !change || change.field !== "messages") invalid();
  onlyKeys(change, ["field", "value"]);
  const value = record(change.value);
  if (!value) invalid();
  onlyKeys(value, ["messaging_product", "metadata", "contacts", "messages"]);
  if (value.messaging_product !== undefined && value.messaging_product !== "whatsapp") invalid();
  const metadata = record(value.metadata);
  if (!metadata) invalid();
  onlyKeys(metadata, ["phone_number_id", "display_phone_number"]);
  if (metadata.display_phone_number !== undefined &&
      (typeof metadata.display_phone_number !== "string" || metadata.display_phone_number.length > 64)) invalid();
  const messages = boundedArray(value.messages, 1);
  const message = record(messages[0]);
  if (messages.length !== 1 || !message || message.type !== "text") invalid();
  onlyKeys(message, ["from", "id", "type", "timestamp", "text", "context"]);
  const text = record(message.text);
  if (!text) invalid();
  onlyKeys(text, ["body"]);
  if (message.context !== undefined) {
    const context = record(message.context);
    if (!context) invalid();
    onlyKeys(context, ["id"]);
    if (context.id === undefined) invalid();
  }
  if (value.contacts !== undefined) {
    const contacts = boundedArray(value.contacts, 1);
    for (const rawContact of contacts) {
      const contact = record(rawContact);
      if (!contact || contact.wa_id !== message.from) invalid();
      onlyKeys(contact, ["wa_id", "profile"]);
      if (contact.profile !== undefined) {
        const profile = record(contact.profile);
        if (!profile || typeof profile.name !== "string" || profile.name.length > 256) invalid();
        onlyKeys(profile, ["name"]);
      }
    }
  }
}

/** Normalize only text messages and delivery statuses from one bound phone. */
export function normalizeWhatsAppWebhook(
  input: unknown,
  trustedPhoneNumberId: string,
  trustedWabaId?: string,
  policy?: WhatsAppWebhookPolicy,
): WhatsAppWebhookEvents {
  const root = record(input);
  if (root?.object !== "whatsapp_business_account") invalid();
  const entries = boundedArray(root.entry, MAX_ENTRIES);
  if (policy !== undefined && policy !== "single-text") invalid();
  if (policy === "single-text") singleTextInput(root, entries, trustedWabaId);
  const messages: XChannelInboundMessage[] = [];
  const statuses: WhatsAppDeliveryStatus[] = [];
  const seenMessages = new Set<string>();

  for (const rawEntry of entries) {
    const entry = record(rawEntry);
    if (!entry) invalid();
    if (trustedWabaId !== undefined && entry.id !== trustedWabaId) {
      throw new WhatsAppChannelError(
        WHATSAPP_CHANNEL_ERROR_CODES.PHONE_MISMATCH,
        "WhatsApp webhook is for another business account",
      );
    }
    for (const rawChange of boundedArray(entry.changes, MAX_CHANGES)) {
      const change = record(rawChange);
      if (!change) invalid();
      if (change.field !== "messages") continue;
      const value = record(change.value);
      const metadata = record(value?.metadata);
      if (!value || !metadata) invalid();
      if (metadata.phone_number_id !== trustedPhoneNumberId) {
        throw new WhatsAppChannelError(
          WHATSAPP_CHANNEL_ERROR_CODES.PHONE_MISMATCH,
          "WhatsApp webhook is for another receiving phone",
        );
      }

      const rawMessages = value.messages === undefined
        ? []
        : boundedArray(value.messages, MAX_EVENTS);
      const rawStatuses = value.statuses === undefined
        ? []
        : boundedArray(value.statuses, MAX_EVENTS);
      if (messages.length + rawMessages.length > MAX_EVENTS ||
          statuses.length + rawStatuses.length > MAX_EVENTS) invalid();

      for (const rawMessage of rawMessages) {
        const message = record(rawMessage);
        if (!message) invalid();
        if (message.type !== "text") continue;
        const text = record(message.text);
        const from = phoneId(message.from);
        const id = externalId(message.id);
        if (typeof text?.body !== "string" ||
            text.body.length === 0 || text.body.length > 4_096) invalid();
        const occurredAt = timestamp(message.timestamp);
        const context = message.context === undefined
          ? undefined
          : record(message.context);
        if (message.context !== undefined && !context) invalid();
        const replyTo = context?.id === undefined
          ? undefined
          : externalId(context.id);
        const dedupeKey = `${from}:${id}`;
        if (seenMessages.has(dedupeKey)) continue;
        seenMessages.add(dedupeKey);
        messages.push({
          _external_user_id: from,
          _external_conversation_id: from,
          _external_message_id: id,
          _text: text.body,
          ...(occurredAt !== undefined ? { _timestamp: occurredAt } : {}),
          ...(replyTo !== undefined
            ? { _reply_to_external_message_id: replyTo }
            : {}),
        });
      }

      for (const rawStatus of rawStatuses) {
        const status = record(rawStatus);
        if (!status) invalid();
        if (status.status !== "sent" && status.status !== "delivered" &&
            status.status !== "read" && status.status !== "failed") continue;
        const occurredAt = timestamp(status.timestamp);
        statuses.push({
          _external_message_id: externalId(status.id),
          _recipient_id: phoneId(status.recipient_id),
          _status: status.status,
          ...(occurredAt !== undefined ? { _timestamp: occurredAt } : {}),
        });
      }
    }
  }

  return { _messages: messages, _statuses: statuses };
}
