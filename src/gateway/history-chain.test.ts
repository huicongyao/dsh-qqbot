import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QQBot,
  runMiddlewareChain,
  type Middleware,
  type MiddlewareContext,
  type QQBotInboundMessage,
} from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import { getGroupHistory, historyGroupKey, resetGroupHistoryForTests } from '../features/group-history.ts';
import { setupMiddlewares } from './middleware-setup.ts';

beforeEach(() => resetGroupHistoryForTests());

function fixture() {
  const config = ConfigSchema({
    appId: 'chain-test',
    appSecret: 'secret',
    access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [], commandMode: 'disabled' },
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = {
    accountAccess: {
      currentAccess: () => config.access,
      isActivePairCode: () => false,
      beginClaimFromMessage: vi.fn(),
    },
  } as unknown as SessionManager;

  const bot = new QQBot({ appId: config.appId, appSecret: config.appSecret, logger });
  const chain: Middleware[] = [];
  vi.spyOn(bot, 'use').mockImplementation((...middleware) => { chain.push(...middleware); return bot; });
  const send = vi.spyOn(bot, 'sendText').mockResolvedValue({ id: 'reply', timestamp: '' });
  setupMiddlewares(bot, config, manager, logger);

  const agent = vi.fn();
  async function receive(content: string, options: { mentioned?: boolean; id?: string } = {}) {
    const now = Date.now();
    const message: QQBotInboundMessage = {
      kind: 'group',
      senderId: 'sender',
      senderName: '小明',
      content,
      messageId: options.id ?? crypto.randomUUID(),
      timestamp: new Date(now).toISOString(),
      rawEventType: options.mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
      groupOpenid: 'team',
      replyTarget: { scope: 'group', targetId: 'team' },
      raw: { id: 'event', content, timestamp: new Date(now).toISOString(), author: { member_openid: 'sender' }, group_openid: 'team' },
    };
    let stopped = false;
    let stopReason: string | undefined;
    const controller = new AbortController();
    const context: MiddlewareContext = {
      bot,
      message,
      replyTarget: message.replyTarget,
      state: {},
      log: logger,
      receivedAt: now,
      signal: controller.signal,
      stop(reason) { stopped = true; stopReason = reason; },
      get stopped() { return stopped; },
      get stopReason() { return stopReason; },
      abort(reason) { controller.abort(reason); this.stop(reason); },
      get aborted() { return controller.signal.aborted; },
    };
    const completed = await runMiddlewareChain(chain, context);
    if (completed) agent();
    return { context, completed, send };
  }

  return { config, agent, receive };
}

describe('群历史与中间件链（回归）', () => {
  it('历史非空时，后续 @ 消息能走完整条链（envelopeFormatter 曾在这里抛 TypeError）', async () => {
    const f = fixture();

    // 第一条不 @：被门控挡下，但会记进群历史
    const first = await f.receive('普通消息');
    expect(first.completed).toBe(false);
    expect(f.agent).not.toHaveBeenCalled();

    // 第二条 @：历史非空，必须能走完链、不抛错
    const second = await f.receive('在吗', { mentioned: true });
    expect(second.completed).toBe(true);
    expect(f.agent).toHaveBeenCalledTimes(1);

    const history = second.context.state.history as Array<{ text: string }>;
    expect(history.map(entry => entry.text)).toEqual(['普通消息']);
  });

  it('连续 @ 时，前一条消息进入下一条的历史', async () => {
    const f = fixture();
    await f.receive('第一条', { mentioned: true });
    const second = await f.receive('第二条', { mentioned: true });

    const history = second.context.state.history as Array<{ text: string }>;
    expect(history.map(entry => entry.text)).toEqual(['第一条']);
    expect(getGroupHistory().size(historyGroupKey(f.config.appId, 'team'))).toBe(2);
  });
});
