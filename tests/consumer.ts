import type { XChannel } from "@xpell/agent";
import { TelegramChannel as RootTelegramChannel } from "@xpell/agent-channels";
import {
  TelegramChannel,
  createTelegramWebhookPath,
  normalizeTelegramUpdate,
  type TelegramChannelConfig,
} from "@xpell/agent-channels/telegram";

const config: TelegramChannelConfig = {
  _id: "telegram-consumer",
  _bot_token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
  _webhook_secret: "consumer-secret",
};

const channel: XChannel = new TelegramChannel(config);
const rootChannel: XChannel = new RootTelegramChannel(config);

createTelegramWebhookPath("centrum", channel._id);
normalizeTelegramUpdate({ update_id: 1 });
void rootChannel;

import { WhatsAppChannel as RootWhatsAppChannel } from "@xpell/agent-channels";
import {
  WhatsAppChannel,
  createWhatsAppWebhookPath,
  normalizeWhatsAppWebhook,
  type WhatsAppChannelConfig,
  type WhatsAppVerifiedTextHandoff,
  type WhatsAppWebhookPolicy,
} from "@xpell/agent-channels/whatsapp";

const whatsAppConfig: WhatsAppChannelConfig = {
  _id: "whatsapp-consumer",
  _phone_number_id: "123456789012345",
  _access_token: "test-access-token-without-real-account",
  _app_secret: "test-app-secret-without-real-account",
  _verify_token: "test-verify-token-without-real-account",
  _graph_api_version: "v22.0",
};
const whatsAppChannel: XChannel = new WhatsAppChannel(whatsAppConfig);
const rootWhatsAppChannel: XChannel = new RootWhatsAppChannel(whatsAppConfig);
createWhatsAppWebhookPath("centrum", whatsAppChannel._id);
normalizeWhatsAppWebhook({ object: "whatsapp_business_account", entry: [] }, "123456789012345");
void rootWhatsAppChannel;

const verifiedHandoff: WhatsAppVerifiedTextHandoff = async event => {
  const originalTimestamp: number | undefined = event._message._timestamp;
  void originalTimestamp;
};
const singleTextPolicy: WhatsAppWebhookPolicy = "single-text";
const handedOffChannel: XChannel = new WhatsAppChannel({ ...whatsAppConfig, _waba_id: "987654321098765" },
  { _verified_text_handoff: verifiedHandoff });
void singleTextPolicy;
void handedOffChannel;
