// larkChatProbe — Lark BOT API で chat msg delta 検出 helper
// Tier 3 (External side-effect) の verify に使う。
// UC12-08 で自作された pattern を package 化。

export type LarkMessage = {
  msgId: string;
  chatId: string;
  createTime: number;
  text: string;
  raw?: unknown;
};

export type LarkChatSnapshot = {
  chatId: string;
  latestMsgId: string | null;
  takenAt: number;
};

type LarkConfig = {
  appId: string;
  appSecret: string;
  chatId: string;
};

// project 側で Lark BOT API 呼出関数を register する (credential 隔離)
type LarkFetcher = (config: LarkConfig, sinceMsgId?: string | null) => Promise<LarkMessage[]>;

let fetcher: LarkFetcher | null = null;

export const larkChatProbe = {
  registerFetcher(impl: LarkFetcher): void {
    fetcher = impl;
  },

  async snapshot(config: LarkConfig): Promise<LarkChatSnapshot> {
    if (!fetcher) {
      throw new Error(
        'larkChatProbe: fetcher not registered. ' +
        'project 側で larkChatProbe.registerFetcher(async (config, since) => {...}) を呼んでください。',
      );
    }
    const msgs = await fetcher(config);
    return {
      chatId: config.chatId,
      latestMsgId: msgs.length > 0 ? msgs[msgs.length - 1].msgId : null,
      takenAt: Date.now(),
    };
  },

  async awaitDelta(opts: {
    appId: string;
    appSecret: string;
    chatId: string;
    since: string | null;
    timeoutMs: number;
    pollIntervalMs?: number;
  }): Promise<LarkMessage[]> {
    if (!fetcher) {
      throw new Error(
        'larkChatProbe: fetcher not registered. ' +
        'project 側で larkChatProbe.registerFetcher(async (config, since) => {...}) を呼んでください。',
      );
    }
    const interval = opts.pollIntervalMs ?? 500;
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      const msgs = await fetcher(
        { appId: opts.appId, appSecret: opts.appSecret, chatId: opts.chatId },
        opts.since,
      );
      if (msgs.length > 0) return msgs;
      await new Promise((r) => setTimeout(r, interval));
    }
    return [];
  },
};
