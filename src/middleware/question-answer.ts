/**
 * 待答问题截获中间件 — 在中间件链中截获 ask_user_question 的答案
 *
 * 必须放在 concurrencyGuard 之前：答案消息需绕过并发守卫的 merge 缓冲，
 * 否则会被排队而无法到达 tryAnswer，导致「turn 等答案 ↔ 答案被缓冲」死锁。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import { cacheMsgId } from '../transport/msgid-cache.ts';
import { normalizeMentions, selfMentionIds, type RawMention } from '../shared/mentions.ts';

export function questionAnswer(manager: SessionManager) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const questionChannel = manager.questionChannel;
    if (!questionChannel) {
      await next();
      return;
    }
    // 答案正文同样会进工具结果给模型看：不能把完整 openid 带进去
    const answer = normalizeMentions(ctx.message.content.trim(), {
      mentions: (ctx.message as unknown as { mentions?: RawMention[] }).mentions,
      selfIds: selfMentionIds(ctx.replyTarget.targetId),
    });
    if (questionChannel.tryAnswer(ctx.replyTarget.scope, ctx.replyTarget.targetId, answer)) {
      // 答案消息被截获（不再走到 bot.on('message')），在此补录其 msgId，
      // 供被动回复超限时切换到缓存的最近 msgId。
      cacheMsgId(ctx.replyTarget.scope, ctx.replyTarget.targetId, ctx.replyTarget.msgId);
      ctx.stop('question-answer');
      return;
    }
    await next();
  };
}
