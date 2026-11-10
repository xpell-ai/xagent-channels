import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  WHATSAPP_CHANNEL_ERROR_CODES as CODES,
  WhatsAppChannel,
  createWhatsAppWebhookPath,
  normalizeWhatsAppWebhook,
} from "@xpell/agent-channels/whatsapp";

const TOKEN = "test-access-token-without-real-account";
const APP_SECRET = "test-app-secret-without-real-account";
const VERIFY_TOKEN = "test-verify-token-without-real-account";
const PHONE_ID = "123456789012345";
const WABA_ID = "987654321098765";

test("opt-in verified handoff waits for durable acceptance and never invokes the direct runtime", async () => {
  let release, entered, received = 0, sends = 0, observed;
  const committed = new Promise(resolve => { release = resolve; });
  const called = new Promise(resolve => { entered = resolve; });
  const channel = new WhatsAppChannel(config(), {
    _fetch: async () => { sends++; throw new Error("no provider calls"); },
    _verified_text_handoff: async event => { observed = event; entered(); await committed; },
  });
  await channel.start({ receive: async () => { received++; return { _ok: true }; } });
  let responded = false;
  const pending = post(channel, webhook({ messages: [textMessage()] })).then(r => { responded = true; return r; });
  await called; assert.equal(responded, false);
  assert.equal(observed._phone_number_id, PHONE_ID); assert.equal(observed._waba_id, WABA_ID);
  assert.equal(observed._message._timestamp, 1700000123000);
  assert.ok(Object.isFrozen(observed)); assert.ok(Object.isFrozen(observed._message));
  release(); assert.equal((await pending).statusCode, 200);
  assert.equal(received, 0); assert.equal(sends, 0);
  await channel.stop();
});

test("handoff policy rejects whole unsupported batches before its first callback; default parser remains compatible", async () => {
  let calls = 0;
  const channel = new WhatsAppChannel(config(), { _verified_text_handoff: async () => { calls++; } });
  await channel.start({ receive: async () => { throw new Error("direct path forbidden"); } });
  const batch = webhook({ messages: [textMessage(), textMessage("wamid.second")] });
  assert.equal(normalizeWhatsAppWebhook(batch, PHONE_ID, WABA_ID)._messages.length, 2);
  const duplicate = webhook({ messages: [textMessage(), textMessage()] });
  assert.equal(normalizeWhatsAppWebhook(duplicate, PHONE_ID, WABA_ID)._messages.length, 1);
  const unsupported = webhook({ messages: [textMessage(), { type: "image" }] });
  assert.equal(normalizeWhatsAppWebhook(unsupported, PHONE_ID, WABA_ID)._messages.length, 1);
  const multiEntry = webhook({ messages: [textMessage()] }); multiEntry.entry.push(structuredClone(multiEntry.entry[0]));
  const multiChange = webhook({ messages: [textMessage()] }); multiChange.entry[0].changes.push({ field: "other", value: {} });
  for (const value of [batch, duplicate, unsupported, multiEntry, multiChange,
    webhook({ statuses: [] }), webhook({ messages: [textMessage()], statuses: [] }),
    webhook({ messages: [textMessage()], _tenant_id: "forged" })]) {
    assert.equal((await post(channel, value)).statusCode, 400);
  }
  assert.equal(calls, 0);
  const tampered = await post(channel, webhook({ messages: [textMessage()] }), {
    headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
  });
  assert.equal(tampered.statusCode, 401); assert.equal(calls, 0);
  await channel.stop();
});

test("handoff requires configured WABA and propagates an unconfirmed acceptance as failure", async () => {
  const missing = new WhatsAppChannel(config({ _waba_id: undefined }), { _verified_text_handoff: async () => {} });
  await assert.rejects(missing.start({ receive: async () => ({ _ok: true }) }), e => e._code === CODES.INVALID_CONFIG);
  const channel = new WhatsAppChannel(config(), { _verified_text_handoff: async () => { throw new Error("unconfirmed commit"); } });
  await channel.start({ receive: async () => { throw new Error("direct path forbidden"); } });
  const response = await post(channel, webhook({ messages: [textMessage()] }));
  assert.equal(response.statusCode, 502); assert.equal(JSON.stringify(response.body).includes("unconfirmed commit"), false);
  await channel.stop(); await missing.stop();
});

function config(overrides = {}) {
  return {
    _id: "whatsapp-customers",
    _phone_number_id: PHONE_ID,
    _waba_id: WABA_ID,
    _access_token: TOKEN,
    _app_secret: APP_SECRET,
    _verify_token: VERIFY_TOKEN,
    _graph_api_version: "v22.0",
    ...overrides,
  };
}

function textMessage(id = "wamid.123", body = "Do you have cocktails?") {
  return {
    from: "50688887777",
    id,
    timestamp: "1700000123",
    type: "text",
    text: { body },
    context: { id: "wamid.prior" },
  };
}

function webhook(value = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: WABA_ID,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: PHONE_ID },
          ...value,
        },
      }],
    }],
  };
}

function signature(raw) {
  return `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
}

function routes(channel) {
  const handlers = new Map();
  const app = {
    get(path, handler) { handlers.set(`GET ${path}`, handler); },
    post(path, handler) { handlers.set(`POST ${path}`, handler); },
  };
  const path = createWhatsAppWebhookPath("pilot-agent", channel._id);
  channel.createRouteContributor({ _path: path })(app);
  return { handlers, path };
}

async function invoke(handler, { raw, headers = {}, query = {}, body } = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
  const request = {
    rawBody: raw,
    body,
    headers,
    query,
    get(name) { return headers[name]; },
  };
  await handler(request, response);
  return response;
}

async function post(channel, payload, options = {}) {
  const { handlers, path } = routes(channel);
  const raw = options.raw ?? Buffer.from(JSON.stringify(payload));
  const headers = options.headers ?? {
    "x-hub-signature-256": signature(raw),
  };
  return await invoke(handlers.get(`POST ${path}`), {
    raw,
    headers,
    body: options.body ?? payload,
  });
}

test("WhatsApp exports, lifecycle, configuration and exact route", async () => {
  const root = await import("@xpell/agent-channels");
  assert.equal(root.WhatsAppChannel, WhatsAppChannel);
  assert.equal(createWhatsAppWebhookPath("pilot-agent", "whatsapp-customers"),
    "/webhooks/whatsapp/pilot-agent/whatsapp-customers");
  const channel = new WhatsAppChannel(config());
  assert.equal(channel.getStatus()._status, "registered");
  await channel.start({ receive: async () => ({ _ok: true }) });
  assert.equal(channel.getStatus()._status, "ready");
  await channel.stop();
  await channel.stop();
  assert.equal(channel.getStatus()._status, "stopped");
  assert.throws(() => channel.createRouteContributor({ _path: "/:business" }),
    (error) => error._code === CODES.INVALID_CONFIG);

  const bad = new WhatsAppChannel(config({ _app_secret: "too-short" }));
  await assert.rejects(() => bad.start({ receive: async () => ({ _ok: true }) }),
    (error) => error._code === CODES.INVALID_CONFIG);
  assert.equal(bad.getStatus()._status, "not_ready");
  assert.equal(JSON.stringify(bad.getStatus()).includes(TOKEN), false);
  assert.equal(JSON.stringify(bad).includes(APP_SECRET), false);
});

test("GET verification returns only a matching challenge", async () => {
  const channel = new WhatsAppChannel(config());
  const { handlers, path } = routes(channel);
  const handler = handlers.get(`GET ${path}`);
  assert.equal((await invoke(handler, { query: {
    "hub.mode": "subscribe",
    "hub.verify_token": VERIFY_TOKEN,
    "hub.challenge": "54321",
  } })).statusCode, 503);
  await channel.start({ receive: async () => ({ _ok: true }) });
  const valid = await invoke(handler, { query: {
    "hub.mode": "subscribe",
    "hub.verify_token": VERIFY_TOKEN,
    "hub.challenge": "54321",
  } });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body, "54321");
  const invalid = await invoke(handler, { query: {
    "hub.mode": "subscribe",
    "hub.verify_token": "wrong",
    "hub.challenge": "54321",
  } });
  assert.equal(invalid.statusCode, 403);
  assert.equal(JSON.stringify(invalid.body).includes(VERIFY_TOKEN), false);
});

test("signed text is normalized from the raw bytes; tampering and absent signatures fail", async () => {
  const received = [];
  const channel = new WhatsAppChannel(config());
  await channel.start({ receive: async (message) => {
    received.push(message);
    return { _ok: true };
  } });
  const payload = webhook({ messages: [textMessage("wamid.abc==")] });
  const valid = await post(channel, payload, { body: { malicious: true } });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(received, [{
    _external_user_id: "50688887777",
    _external_conversation_id: "50688887777",
    _external_message_id: "wamid.abc==",
    _text: "Do you have cocktails?",
    _timestamp: 1700000123000,
    _reply_to_external_message_id: "wamid.prior",
  }]);
  const raw = Buffer.from(JSON.stringify(payload));
  const tampered = Buffer.from(raw);
  tampered[tampered.indexOf(Buffer.from("cocktails"))] ^= 1;
  const bad = await post(channel, payload, {
    raw: tampered,
    headers: { "x-hub-signature-256": signature(raw) },
  });
  assert.equal(bad.statusCode, 401);
  assert.equal((await post(channel, payload, { headers: {} })).statusCode, 401);
  assert.equal(received.length, 1);
});

test("wrong receiving phone or WABA is rejected before any event", async () => {
  const received = [];
  const channel = new WhatsAppChannel(config());
  await channel.start({ receive: async (message) => {
    received.push(message);
    return { _ok: true };
  } });
  assert.equal((await post(channel, webhook({
    metadata: { phone_number_id: "999" },
    messages: [textMessage()],
  }))).statusCode, 403);
  const wrongWaba = webhook({ messages: [textMessage()] });
  wrongWaba.entry[0].id = "111";
  assert.equal((await post(channel, wrongWaba)).statusCode, 403);
  assert.equal(received.length, 0);
});

test("multiple texts process separately, in-batch duplicates and unsupported types are ignored", async () => {
  const received = [];
  const channel = new WhatsAppChannel(config());
  await channel.start({ receive: async (message) => {
    received.push(message);
    return { _ok: true };
  } });
  const result = await post(channel, webhook({ messages: [
    textMessage("wamid.1", "one"),
    textMessage("wamid.1", "one"),
    { type: "image", id: "wamid.image", from: "50688887777" },
    textMessage("wamid.2", "two"),
  ] }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(received.map((m) => m._text), ["one", "two"]);
  const ignored = await post(channel, webhook({ messages: [
    { type: "image", id: "wamid.image2" },
  ] }));
  assert.deepEqual(ignored.body, { _ok: true, _ignored: true });
});

test("statuses remain provider observations and never enter chat", async () => {
  const received = [];
  const statuses = [];
  const channel = new WhatsAppChannel(config(), {
    _on_delivery_status: async (status) => { statuses.push(status); },
  });
  await channel.start({ receive: async (message) => {
    received.push(message);
    return { _ok: true };
  } });
  const response = await post(channel, webhook({ statuses: [
    { id: "wamid.sent", recipient_id: "50688887777", status: "sent", timestamp: "1700000123" },
    { id: "wamid.delivered", recipient_id: "50688887777", status: "delivered", timestamp: "1700000124" },
    { id: "wamid.failed", recipient_id: "50688887777", status: "failed", timestamp: "1700000125", errors: [{ title: "private" }] },
  ] }));
  assert.equal(response.statusCode, 200);
  assert.equal(received.length, 0);
  assert.deepEqual(statuses.map((s) => s._status), ["sent", "delivered", "failed"]);
  assert.equal(JSON.stringify(statuses).includes("private"), false);
});

test("oversize, missing raw body, invalid text and non-ready requests fail closed", async () => {
  const channel = new WhatsAppChannel(config());
  const payload = webhook({ messages: [textMessage()] });
  const raw = Buffer.from(JSON.stringify(payload));
  assert.equal((await post(channel, payload)).statusCode, 503);
  await channel.start({ receive: async () => ({ _ok: true }) });
  const { handlers, path } = routes(channel);
  const handler = handlers.get(`POST ${path}`);
  assert.equal((await invoke(handler, { headers: {
    "x-hub-signature-256": signature(raw),
  } })).statusCode, 400);
  const huge = Buffer.alloc(256 * 1024 + 1);
  assert.equal((await invoke(handler, { raw: huge, headers: {
    "x-hub-signature-256": signature(huge),
  } })).statusCode, 413);
  const invalid = webhook({ messages: [{ ...textMessage(), text: { body: "" } }] });
  assert.equal((await post(channel, invalid)).statusCode, 400);
  assert.equal(normalizeWhatsAppWebhook(webhook({ statuses: [] }), PHONE_ID, WABA_ID)._messages.length, 0);
});

test("send uses one Graph request and returns acceptance, never delivery", async () => {
  const calls = [];
  const channel = new WhatsAppChannel(config(), {
    _now: () => 1700000500000,
    _fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.outbound" }],
      }), { status: 200 });
    },
  });
  await channel.start({ receive: async () => ({ _ok: true }) });
  const result = await channel.send({
    _external_conversation_id: "50688887777",
    _text: "Yes, see our menu.",
    _reply_to_external_message_id: "wamid.123",
  });
  assert.deepEqual(result, {
    _accepted: true,
    _external_message_id: "wamid.outbound",
    _accepted_at: 1700000500000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://graph.facebook.com/v22.0/${PHONE_ID}/messages`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "50688887777",
    type: "text",
    text: { preview_url: false, body: "Yes, see our menu." },
    context: { message_id: "wamid.123" },
  });
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("429, 5xx, timeout and malformed acceptance expose safe errors without retry", async () => {
  for (const [fetchMock, expected] of [
    [async () => new Response("private-response", { status: 400 }), CODES.SEND_REJECTED],
    [async () => new Response("private-response", { status: 429 }), CODES.SEND_RATE_LIMITED],
    [async () => new Response("private-response", { status: 503 }), CODES.SEND_UNCERTAIN],
    [async () => { throw new Error("private-network-detail"); }, CODES.SEND_UNCERTAIN],
    [async () => new Response("not-json", { status: 200 }), CODES.SEND_UNCERTAIN],
  ]) {
    let calls = 0;
    const channel = new WhatsAppChannel(config(), {
      _fetch: async (...args) => { calls += 1; return await fetchMock(...args); },
    });
    await channel.start({ receive: async () => ({ _ok: true }) });
    await assert.rejects(() => channel.send({
      _external_conversation_id: "50688887777",
      _text: "hello",
    }), (error) => {
      assert.equal(error._code, expected);
      assert.equal(error._send_failure_category,
        expected === CODES.SEND_REJECTED ? "rejected" :
          expected === CODES.SEND_RATE_LIMITED ? "rate_limited" : "unknown");
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      assert.equal(error.message.includes("private"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("send diagnostics retain only safe HTTP and Meta codes", async () => {
  const diagnostics = [];
  const originalWarn = console.warn;
  console.warn = (...args) => diagnostics.push(args);
  try {
    for (const [response, expected] of [
      [new Response(JSON.stringify({ error: {
        code: 190, error_subcode: 463,
        message: "private provider detail", fbtrace_id: "private trace",
      } }), { status: 401 }), {
        _source: "http_response", _code: CODES.SEND_REJECTED,
        _http_status: 401, _meta_error_code: 190,
        _meta_error_subcode: 463, _category: "rejected", _retryable: true,
      }],
      [new Response("private response", { status: 400 }), {
        _source: "http_response", _code: CODES.SEND_REJECTED,
        _http_status: 400, _category: "rejected", _retryable: true,
      }],
      [new Response(JSON.stringify({ error: { code: "190", error_subcode: -1 } }),
        { status: 429 }), {
        _source: "http_response", _code: CODES.SEND_RATE_LIMITED,
        _http_status: 429, _category: "rate_limited", _retryable: true,
      }],
      [new Response(JSON.stringify({ error: { code: 131000 } }),
        { status: 503 }), {
        _source: "http_response", _code: CODES.SEND_UNCERTAIN,
        _http_status: 503, _meta_error_code: 131000,
        _category: "unknown", _retryable: false,
      }],
    ]) {
      const channel = new WhatsAppChannel(config(), {
        _fetch: async () => response,
      });
      await channel.start({ receive: async () => ({ _ok: true }) });
      await assert.rejects(() => channel.send({
        _external_conversation_id: "50688887777", _text: "private message",
      }));
      assert.deepEqual(diagnostics.pop(), ["[whatsapp] send failed", expected]);
    }
    const channel = new WhatsAppChannel(config(), {
      _fetch: async () => { throw new Error("private transport detail"); },
    });
    await channel.start({ receive: async () => ({ _ok: true }) });
    await assert.rejects(() => channel.send({
      _external_conversation_id: "50688887777", _text: "private message",
    }));
    assert.deepEqual(diagnostics.pop(), ["[whatsapp] send failed", {
      _source: "transport", _code: CODES.SEND_UNCERTAIN,
      _category: "unknown", _retryable: false,
    }]);
    assert.equal(diagnostics.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("diagnostic logger failure does not change send rejection", async () => {
  const originalWarn = console.warn;
  console.warn = () => { throw new Error("private logger failure"); };
  try {
    const channel = new WhatsAppChannel(config(), {
      _fetch: async () => new Response(JSON.stringify({
        error: { code: 190, error_subcode: 463 },
      }), { status: 401 }),
    });
    await channel.start({ receive: async () => ({ _ok: true }) });
    await assert.rejects(() => channel.send({
      _external_conversation_id: "50688887777", _text: "private message",
    }), (error) => error._code === CODES.SEND_REJECTED &&
      error._send_failure_category === "rejected");
  } finally {
    console.warn = originalWarn;
  }
});

test("send timeout aborts a single request and reports uncertain outcome", async () => {
  let calls = 0;
  const channel = new WhatsAppChannel(config({ _send_timeout_ms: 100 }), {
    _fetch: async (_url, options) => {
      calls += 1;
      return await new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("abort did not fire")), 500);
        options.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(options.signal.reason);
        }, { once: true });
      });
    },
  });
  await channel.start({ receive: async () => ({ _ok: true }) });
  await assert.rejects(() => channel.send({
    _external_conversation_id: "50688887777", _text: "hello",
  }), (error) => error._code === CODES.SEND_UNCERTAIN);
  assert.equal(calls, 1);
});
