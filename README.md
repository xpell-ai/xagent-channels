# @xpell/agent-channels

## 2.0.8 release candidate

Target publication date: **13 November 2026**; this candidate has not been published.
Use the coordinated 2.0.8 runtime dependencies. See [CHANGELOG](./CHANGELOG.md)
for package changes and qualification limits; [LICENSE](./LICENSE) contains the MIT terms.

Official provider Channel adapters for `@xpell/agent`.

The package provides text-only `TelegramChannel` and `WhatsAppChannel`
provider adapters. Both are plain `XChannel`s owned by an `XAgent`, not
`XModule`s. Provider configuration, webhook registration, application scope,
and persistent identity resolution belong to the host application.

## Telegram setup

```ts
import { XAgent } from "@xpell/agent";
import {
  TelegramChannel,
  createTelegramWebhookPath
} from "@xpell/agent-channels/telegram";
import { XNode } from "@xpell/node";

const telegram = new TelegramChannel({
  _id: "telegram-customers",
  _bot_token: process.env.TELEGRAM_BOT_TOKEN!,
  _webhook_secret: process.env.TELEGRAM_WEBHOOK_SECRET!
});

const agent = new XAgent({
  _name: "centrum",
  _channels: [telegram]
});

const path = createTelegramWebhookPath(agent._name, telegram._id);

const node = new XNode();
await node.start({
  _routes: [telegram.createRouteContributor({ _path: path })],
  _modules: [agent]
});
```

The host supplies the exact POST route. `createTelegramWebhookPath()` provides
the optional deterministic convention:

```text
/webhooks/telegram/{agent_name}/{channel_id}
```

This supports multiple Agents and multiple Telegram Channels on the same
XNode. The route path is routing information, not authentication.

## Runtime flow

```text
Telegram webhook POST
  -> verify X-Telegram-Bot-Api-Secret-Token
  -> normalize Telegram text message
  -> bound XChannelRuntime.receive()
  -> _x.execute(agent.receive-message)
  -> XAgent.onMessage()
  -> TelegramChannel.send()
  -> Telegram Bot API sendMessage
```

Inbound normalization preserves Telegram user, chat, and message IDs as
separate generic fields. Telegram timestamps are converted from Unix seconds
to milliseconds. A Telegram reply is exposed only as the generic reply-to
external message ID. Provider payloads and Telegram metadata do not cross the
Channel boundary.

If `onMessage()` returns a response, `XAgent` sends it through the same
Telegram Channel. An explicit Agent `send-message` operation can select the
Channel by `_channel_id`. `send()` maps `_external_conversation_id` to
Telegram `chat_id`, uses current `reply_parameters` for replies, and returns
the accepted Telegram message ID. Acceptance is not a human delivery receipt.

## Lifecycle and webhook behavior

The adapter follows the generic lifecycle:

```text
registered -> starting -> ready
                    \-> not_ready
ready -> stopped
```

Configuration is validated during `start()`. Startup and stop are idempotent;
there is no automatic retry. Because XNode routes can become reachable before
application modules finish loading, an authenticated request to a non-ready
Channel receives `503` and is not dropped.

Webhook handling is synchronous: authenticate, normalize, await Agent
processing, then acknowledge. Invalid authentication receives `401` and never
reaches the Agent. Unsupported/non-text Telegram updates are safely
acknowledged as ignored. Invalid text updates receive `400`; Agent or outbound
processing failure receives a non-success response so Telegram may retry.

Configure the same `_webhook_secret` as Telegram's `setWebhook.secret_token`.
Tokens and secrets are held in private fields and are never included in status,
public errors, logs, or normalized DTOs. The host remains responsible for HTTPS
and registering the webhook URL with Telegram.

## Imports

```ts
import { TelegramChannel } from "@xpell/agent-channels/telegram";
// The root also re-exports the implemented Telegram surface:
import { TelegramChannel } from "@xpell/agent-channels";
```

## WhatsApp Cloud API setup

```ts
import { XAgent } from "@xpell/agent";
import {
  WhatsAppChannel,
  createWhatsAppWebhookPath,
} from "@xpell/agent-channels/whatsapp";
import { XNode } from "@xpell/node";

const whatsapp = new WhatsAppChannel({
  _id: "whatsapp-customers",
  _phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  _waba_id: process.env.WHATSAPP_WABA_ID!, // optional, recommended
  _access_token: process.env.WHATSAPP_ACCESS_TOKEN!,
  _app_secret: process.env.WHATSAPP_APP_SECRET!,
  _verify_token: process.env.WHATSAPP_VERIFY_TOKEN!,
  _graph_api_version: process.env.WHATSAPP_GRAPH_API_VERSION!,
});
const agent = new XAgent({ _name: "customer-agent", _channels: [whatsapp] });
const path = createWhatsAppWebhookPath(agent._name, whatsapp._id);
const node = new XNode();
await node.start({
  _routes: [whatsapp.createRouteContributor({ _path: path })],
  _modules: [agent],
});
```

The host must use HTTPS, configure Meta's callback and WABA subscription, and
select the intended XVM application from trusted server settings. Use one
channel instance per configured receiving phone; the route accepts only that
phone number ID (and, when supplied, that WABA ID). No webhook field selects
an XVM app or Channel ID. A caller may additionally provide
`_send_timeout_ms` (100–60,000 ms, default 10,000 ms) and inject `_fetch`,
`_now`, or `_on_delivery_status` through constructor dependencies.

GET verification compares `hub.verify_token` and returns `hub.challenge`.
POST verifies `x-hub-signature-256` with the configured app secret over the
exact raw JSON bytes provided by XNode. Missing raw bytes, invalid signatures,
wrong receiving phones, and payloads over 256 KiB fail closed. XNode's JSON
parser preserves the required `rawBody` buffer. Valid text messages are
normalized using Meta's sender and message IDs and passed to the bound
`XChannelRuntime.receive()`; the runtime injects the trusted Channel ID.
Unsupported message types are acknowledged without text fabrication. The
Starter's application-scoped conversation lifecycle persistently deduplicates
repeated provider message IDs; the adapter also drops duplicates within one
webhook batch. A retry after partial batch processing relies on that durable
Starter deduplication.

### Opt-in verified text handoff

`WhatsAppChannelDependencies._verified_text_handoff` is an optional
`WhatsAppVerifiedTextHandoff` callback. The default direct Channel behavior above
is unchanged. With this opt-in, the existing raw-byte verifier and normalizer
finish before one exclusive handoff; direct `runtime.receive` is not also called.
The callback receives configured `_phone_number_id`/`_waba_id` and a frozen
normalized `_message`. WABA configuration is mandatory in this mode. Provider
timestamps retain the existing seconds-to-milliseconds conversion.

This mode selects the existing normalizer's optional fourth argument,
`"single-text"` (`WhatsAppWebhookPolicy`). It rejects the whole input before
handoff unless it has one entry, one messages change and exactly one supported
text event. Multiple events, raw duplicate batches, statuses, mixed unsupported
events and unknown fields outside this narrow subset fail closed; optional
contacts/display metadata are bounded and never select an identity. Default
normalization continues to support its existing batches/status observations.

The host callback must resolve **only after confirmed durable acceptance** and
reject on failed or unconfirmed acceptance; rejection returns the existing safe
HTTP processing error. Successful handoff does not assert consumer processing or
provider delivery. The callback must have an application-owned bounded lifecycle;
the Channel adds no retry, timer, persistence or provider call. No XNet dependency
or new HTTP endpoint is introduced. This seam's tested Pulse use is synthetic
only; it does not authorize live provider traffic or change Channel ownership.

`_external_conversation_id` is the WhatsApp sender ID for a Customer reply.
`send()` makes one text request to Graph `/{phone-number-id}/messages` and
returns a provider acceptance ID. Acceptance is not delivery. Non-success
HTTP responses, timeout, or malformed success responses produce safe error
codes; uncertain outcomes are never automatically retried. Signed delivery
status callbacks (`sent`, `delivered`, `read`, `failed`) are passed to the
optional `_on_delivery_status` observer as minimal metadata and never enter
the Agent as Customer messages. The observer must make its own durable updates
and repeated callbacks idempotent if it needs receipt persistence.

The adapter has no template, consent, service-window, marketing, billing,
Customer onboarding, Reward, or Fulfillment logic. The host must authorize
explicit outbound recipients and enforce WhatsApp's messaging window before
sending. Its `XChannel` contract carries a recipient ID but no proof of that
ID's provenance; the adapter validates its shape and uses the trusted
host/Agent composition boundary for authorization.

## Current limitations

V0.1 does not provide Telegram polling, media, files, callback queries, inline
keyboards, command frameworks, group administration, broadcasts, edits,
reactions, payments, or delivery receipts. WhatsApp V0.1 supports only text,
webhook verification, and provider status observations; it does not provide
Messenger or Instagram adapters.

The package has no persistence, users/customers, identity mapping,
conversations, messages, memory, CRM, loyalty, campaigns, XAI behavior,
capability installation, provider registry, bot registry, queues, schedulers,
or product-specific Pulse logic.

## Development

```bash
pnpm build
pnpm test
```

Tests use injected `fetch` implementations and never call Meta or Telegram.

## License

MIT
