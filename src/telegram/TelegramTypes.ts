export type TelegramUser = {
  id: number;
};

export type TelegramChat = {
  id: number;
};

export type TelegramMessage = {
  message_id: number;
  date?: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
  reply_to_message?: Pick<TelegramMessage, "message_id">;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  parameters?: { retry_after?: number };
};

export type TelegramSentMessage = {
  message_id: number;
};
