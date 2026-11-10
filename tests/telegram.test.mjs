import assert from "node:assert/strict";
import test from "node:test";

import {
  TELEGRAM_CHANNEL_ERROR_CODES,
  TelegramChannel,
  TelegramChannelError,
  createTelegramWebhookPath,
  normalizeTelegramUpdate,
} from "@xpell/agent-channels/telegram";

const VALID_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
const VALID_SECRET = "telegram_webhook-secret";

function channelConfig(overrides = {}) {
  return {
    _id: "telegram-test",
    _bot_token: VALID_TOKEN,
    _webhook_secret: VALID_SECRET,
    ...overrides,
  };
}

function runtime(receive = async () => ({ _ok: true, _ts: 1, _pt: 0, _result: null })) {
  return { receive };
}

function telegramUpdate(overrides = {}) {
  return {
    update_id: 987,
    message: {
      message_id: 333,
      date: 1_700_000_123,
      text: "hello",
      from: { id: 111 },
      chat: { id: -222 },
      reply_to_message: { message_id: 332 },
      ...overrides,
    },
  };
}

test("package exports TelegramChannel from root and provider subpath", async () => {
  const root = await import("@xpell/agent-channels");
  const telegram = await import("@xpell/agent-channels/telegram");

  assert.equal(root.TelegramChannel, telegram.TelegramChannel);
  assert.equal(typeof telegram.normalizeTelegramUpdate, "function");
});

test("TelegramChannel implements the Channel lifecycle and stops idempotently", async () => {
  const channel = new TelegramChannel(channelConfig());

  assert.deepEqual(channel.getStatus(), {
    _id: "telegram-test",
    _provider: "telegram",
    _status: "registered",
    _ready: false,
  });

  const starting = channel.start(runtime());
  assert.equal(channel.getStatus()._status, "starting");
  await starting;
  await channel.start(runtime());
  assert.equal(channel.getStatus()._status, "ready");
  assert.equal(channel.getStatus()._ready, true);

  await channel.stop();
  await channel.stop();
  assert.equal(channel.getStatus()._status, "stopped");
});

test("invalid configuration becomes not_ready without exposing secrets", async () => {
  const token = "bad-secret-token-value";
  const secret = "invalid secret with spaces";
  const channel = new TelegramChannel(
    channelConfig({ _bot_token: token, _webhook_secret: secret }),
  );

  await assert.rejects(
    () => channel.start(runtime()),
    (error) => {
      assert.ok(error instanceof TelegramChannelError);
      assert.equal(error._code, TELEGRAM_CHANNEL_ERROR_CODES.INVALID_CONFIG);
      assert.equal(JSON.stringify(error).includes(token), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );

  const status = channel.getStatus();
  assert.equal(status._status, "not_ready");
  assert.equal(status._ready, false);
  assert.equal(status._error._code, TELEGRAM_CHANNEL_ERROR_CODES.INVALID_CONFIG);
  assert.equal(JSON.stringify(status).includes(token), false);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(JSON.stringify(channel).includes(token), false);
  assert.equal(JSON.stringify(channel).includes(secret), false);
});

test("Telegram text normalization preserves separate IDs, text, timestamp, and reply", () => {
  assert.deepEqual(normalizeTelegramUpdate(telegramUpdate()), {
    _external_user_id: "111",
    _external_conversation_id: "-222",
    _external_message_id: "333",
    _text: "hello",
    _timestamp: 1_700_000_123_000,
    _reply_to_external_message_id: "332",
  });
});

test("unsupported update kinds and non-text messages are ignored", () => {
  assert.equal(normalizeTelegramUpdate({ update_id: 1, callback_query: {} }), undefined);
  assert.equal(
    normalizeTelegramUpdate(telegramUpdate({ text: undefined, photo: [{}] })),
    undefined,
  );
});

test("malformed supported text updates fail with a safe structured error", () => {
  assert.throws(
    () => normalizeTelegramUpdate(telegramUpdate({ from: undefined })),
    (error) => {
      assert.equal(error._code, TELEGRAM_CHANNEL_ERROR_CODES.BAD_UPDATE);
      assert.equal(JSON.stringify(error).includes(JSON.stringify(telegramUpdate())), false);
      return true;
    },
  );
});

test("send maps generic outbound fields to sendMessage and returns acceptance", async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 444 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const channel = new TelegramChannel(channelConfig(), {
    _fetch: fetchMock,
    _now: () => 1_700_000_999_000,
  });
  await channel.start(runtime());

  const result = await channel.send({
    _external_conversation_id: "-222",
    _text: "hi",
    _reply_to_external_message_id: "333",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.endsWith("/sendMessage"), true);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    chat_id: "-222",
    text: "hi",
    reply_parameters: { message_id: 333 },
  });
  assert.deepEqual(result, {
    _accepted: true,
    _external_message_id: "444",
    _accepted_at: 1_700_000_999_000,
  });
});

test("Telegram API failures expose only a safe structured error", async () => {
  const providerBodySecret = "provider-response-sensitive-detail";
  const channel = new TelegramChannel(channelConfig(), {
    _fetch: async () =>
      new Response(
        JSON.stringify({ ok: false, description: providerBodySecret }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  });
  await channel.start(runtime());

  await assert.rejects(
    () =>
      channel.send({
        _external_conversation_id: "-222",
        _text: "hi",
      }),
    (error) => {
      assert.equal(error._code, TELEGRAM_CHANNEL_ERROR_CODES.SEND_FAILED);
      assert.equal(error._send_failure_category, "rejected");
      assert.equal(JSON.stringify(error).includes(providerBodySecret), false);
      assert.equal(error.message.includes(providerBodySecret), false);
      return true;
    },
  );
});

test("Telegram timeout and ambiguous server errors have unknown outcomes", async () => {
  for (const fetchMock of [
    async () => { throw new Error("private network detail"); },
    async () => new Response("private server detail", { status: 503 }),
    async () => new Response("private timeout detail", { status: 408 }),
    async () => new Response("not-json", { status: 200 }),
  ]) {
    const channel = new TelegramChannel(channelConfig(), { _fetch: fetchMock });
    await channel.start(runtime());
    await assert.rejects(() => channel.send({
      _external_conversation_id: "-222",
      _text: "hello",
    }), (error) => error._send_failure_category === "unknown");
  }
});

test("Telegram exposes only validated retry delay and permanent rejection signals", async () => {
  for (const [status, headers, category, permanent, delay] of [
    [429, { "retry-after": "7" }, "rate_limited", false, 7_000],
    [403, {}, "rejected", true, undefined],
  ]) {
    const channel = new TelegramChannel(channelConfig(), {
      _fetch: async () => new Response("private", { status, headers }),
    });
    await channel.start(runtime());
    await assert.rejects(() => channel.send({
      _external_conversation_id: "-222", _text: "hello",
    }), (error) => {
      assert.equal(error._send_failure_category, category);
      assert.equal(error._permanent, permanent);
      assert.equal(error._retry_after_ms, delay);
      return true;
    });
  }
  const bodyChannel = new TelegramChannel(channelConfig(), {
    _fetch: async () => new Response(JSON.stringify({ ok: false,
      parameters: { retry_after: 9 }, description: "private" }), { status: 429 }),
  });
  await bodyChannel.start(runtime());
  await assert.rejects(() => bodyChannel.send({
    _external_conversation_id: "-222", _text: "hello",
  }), (error) => error._send_failure_category === "rate_limited" &&
    error._retry_after_ms === 9_000 && !error.message.includes("private"));
});

test("Telegram recovery policy rejects invalid reply IDs before a send claim", async () => {
  const channel = new TelegramChannel(channelConfig(), { _fetch: async () => {
    throw new Error("must not call provider");
  } });
  await channel.start(runtime());
  assert.equal(channel.authorizeRecovery({ _external_conversation_id: "-222",
    _text: "hello", _reply_to_external_message_id: "99999999999999999999" }), false);
  assert.equal(channel.authorizeRecovery({ _external_conversation_id: "-222",
    _text: "hello", _reply_to_external_message_id: "3" }), true);
});

test("route paths are exact and deterministic", () => {
  assert.equal(
    createTelegramWebhookPath("centrum", "telegram-customers"),
    "/webhooks/telegram/centrum/telegram-customers",
  );

  const channel = new TelegramChannel(channelConfig());
  assert.throws(
    () => channel.createRouteContributor({ _path: "/webhooks/:channel" }),
    (error) => error._code === TELEGRAM_CHANNEL_ERROR_CODES.INVALID_CONFIG,
  );
});

test("the package declares no persistence, AI, SDK, queue, or scheduler dependency", async () => {
  const packageJson = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(packageJson.peerDependencies).sort(), [
    "@xpell/agent",
    "@xpell/node",
  ]);
});
