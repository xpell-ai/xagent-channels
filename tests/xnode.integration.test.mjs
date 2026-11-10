import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { XAgent } from "@xpell/agent";
import {
  TelegramChannel,
  createTelegramWebhookPath,
} from "@xpell/agent-channels/telegram";
import { Settings, XNode, _x } from "@xpell/node";

const AGENT_NAME = "telegram-integration-agent";
const CHANNEL_ID = "telegram-integration";
const BOT_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
const WEBHOOK_SECRET = "integration_secret";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHttpTestWebServer() {
  const contributors = [];
  const routes = [];
  let server;
  const listening = deferred();
  let listeningReject;
  const listeningResult = new Promise((resolve, reject) => {
    listening.promise.then(resolve, reject);
    listeningReject = reject;
  });

  const app = {
    post(routePath, ...handlers) {
      routes.push({ method: "POST", path: routePath, handler: handlers.at(-1) });
    },
    use() {},
  };

  const web = {
    onSetup() {},
    init() {},
    useRoutes(contributor) {
      contributors.push(contributor);
    },
    load() {
      for (const contributor of contributors) contributor(app, web);
    },
    async start() {
      server = http.createServer(async (request, response) => {
        const route = routes.find(
          (candidate) =>
            candidate.method === request.method && candidate.path === request.url,
        );
        if (!route) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ _ok: false }));
          return;
        }

        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        const expressRequest = {
          headers: request.headers,
          body: raw.length > 0 ? JSON.parse(raw) : undefined,
          get(name) {
            const value = request.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
        };
        let statusCode = 200;
        const headers = {};
        const expressResponse = {
          status(code) {
            statusCode = code;
            return this;
          },
          set(name, value) {
            headers[name] = value;
            return this;
          },
          json(body) {
            response.writeHead(statusCode, {
              "content-type": "application/json",
              ...headers,
            });
            response.end(JSON.stringify(body));
            return this;
          },
        };
        await route.handler(expressRequest, expressResponse);
      });
      server.once("error", listeningReject);
      server.listen(0, "127.0.0.1", () => listening.resolve());
      await listeningResult;
    },
    get baseUrl() {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}`;
    },
    get routePaths() {
      return routes.map((route) => route.path);
    },
    async close() {
      if (!server) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    listening: listeningResult,
  };
  return web;
}

async function postUpdate(baseUrl, routePath, secret, body) {
  return await fetch(`${baseUrl}${routePath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(body),
  });
}

test("XNode _routes drives the full webhook -> XAgent -> Telegram API path", async () => {
  const workFolder = await mkdtemp(path.join(tmpdir(), "xagent-telegram-"));
  const agentLoadGate = deferred();
  const sentRequests = [];
  const receivedMessages = [];

  class GreetingAgent extends XAgent {
    async onMessage(message) {
      receivedMessages.push({ ...message });
      if (message._text === "fail") throw new Error("test handler failure");
      if (message._text !== "hello") return undefined;
      return {
        _external_conversation_id: message._external_conversation_id,
        _text: "hi",
        _reply_to_external_message_id: message._external_message_id,
      };
    }
  }

  const telegram = new TelegramChannel(
    {
      _id: CHANNEL_ID,
      _bot_token: BOT_TOKEN,
      _webhook_secret: WEBHOOK_SECRET,
    },
    {
      _fetch: async (url, options) => {
        sentRequests.push({ url: String(url), body: JSON.parse(options.body) });
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 901 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      _now: () => 1_700_000_500_000,
    },
  );
  const agent = new GreetingAgent({
    _name: AGENT_NAME,
    _channels: [telegram],
  });
  const routePath = createTelegramWebhookPath(AGENT_NAME, CHANNEL_ID);
  const node = new XNode();
  const web = createHttpTestWebServer();
  node._web_server = web;

  const originalStart = _x.start;
  const originalLoadModuleAsync = _x.loadModuleAsync;
  const previousAgent = _x._modules[AGENT_NAME];
  delete _x._modules[AGENT_NAME];

  _x.start = () => {};
  _x.loadModuleAsync = async (module) => {
    if (module === agent) {
      await agentLoadGate.promise;
      await originalLoadModuleAsync.call(_x, module);
    }
  };

  const startPromise = node.start({
    _work_folder: workFolder,
    _routes: [telegram.createRouteContributor({ _path: routePath })],
    _modules: [agent],
  });

  try {
    await web.listening;
    assert.ok(web.routePaths.includes(routePath));

    const beforeReady = await postUpdate(
      web.baseUrl,
      routePath,
      WEBHOOK_SECRET,
      { update_id: 1, message: { message_id: 1, text: "hello", from: { id: 2 }, chat: { id: 3 } } },
    );
    assert.equal(beforeReady.status, 503);
    assert.equal(receivedMessages.length, 0);

    agentLoadGate.resolve();
    await startPromise;
    assert.equal(telegram.getStatus()._status, "ready");

    const unauthorized = await postUpdate(
      web.baseUrl,
      routePath,
      "wrong-secret",
      { update_id: 2, message: { message_id: 2, text: "hello", from: { id: 3 }, chat: { id: 4 } } },
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(receivedMessages.length, 0);

    const accepted = await postUpdate(
      web.baseUrl,
      routePath,
      WEBHOOK_SECRET,
      {
        update_id: 3,
        message: {
          message_id: 700,
          date: 1_700_000_400,
          text: "hello",
          from: { id: 500 },
          chat: { id: -600 },
        },
      },
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { _ok: true });
    assert.deepEqual(receivedMessages, [
      {
        _channel_id: CHANNEL_ID,
        _external_user_id: "500",
        _external_conversation_id: "-600",
        _external_message_id: "700",
        _text: "hello",
        _timestamp: 1_700_000_400_000,
      },
    ]);
    assert.equal(sentRequests.length, 1);
    assert.equal(sentRequests[0].url.endsWith("/sendMessage"), true);
    assert.deepEqual(sentRequests[0].body, {
      chat_id: "-600",
      text: "hi",
      reply_parameters: { message_id: 700 },
    });

    const failed = await postUpdate(
      web.baseUrl,
      routePath,
      WEBHOOK_SECRET,
      {
        update_id: 31,
        message: {
          message_id: 701,
          text: "fail",
          from: { id: 500 },
          chat: { id: -600 },
        },
      },
    );
    assert.equal(failed.status, 502);
    assert.equal(sentRequests.length, 1);

    const ignored = await postUpdate(
      web.baseUrl,
      routePath,
      WEBHOOK_SECRET,
      { update_id: 4, callback_query: {} },
    );
    assert.equal(ignored.status, 200);
    assert.deepEqual(await ignored.json(), { _ok: true, _ignored: true });
    assert.equal(receivedMessages.length, 2);
  } finally {
    agentLoadGate.resolve();
    await startPromise.catch(() => {});
    await web.close();
    await telegram.stop();
    _x.start = originalStart;
    _x.loadModuleAsync = originalLoadModuleAsync;
    delete _x._modules[AGENT_NAME];
    if (previousAgent !== undefined) _x._modules[AGENT_NAME] = previousAgent;
    Settings.close();
    await rm(workFolder, { recursive: true, force: true });
  }
});
