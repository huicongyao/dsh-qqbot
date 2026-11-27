/**
 * SDK 中间件编排
 *
 * 根据插件配置组装 SDK 内置中间件链（洋葱模型）。
 * 中间件负责过滤与上下文富化；最终消息统一由 bot.on('message') 处理转发。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  errorHandler,
  messageFilter,
  accessPolicy,
  mentionGate,
  contentSanitizer,
  rateLimiter,
  slashCommand,
  concurrencyGuard,
  typingIndicator,
  quoteRef,
} from '@tencent-connect/qqbot-nodejs';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { buildCommandList } from '../commands/index.ts';
import { attachmentProcessor } from '../middleware/attachment.ts';
import { questionAnswer } from '../middleware/question-answer.ts';
import { getGroupHistory, groupHistoryMiddleware, toHistoryLimits } from '../features/group-history.ts';
import { historyMediaProcessor } from '../middleware/history-media.ts';
import { createInterjectTracker, type InterjectTracker } from '../features/interject.ts';
import { messageSenderName } from '../shared/message-sender-name.ts';

/**
 * 群聊插话判断：没人 @ 时，按概率把这条消息当成在叫机器人。
 *
 * 只有机器人消息档位是「获取群内全部消息」时才会真的收到非 @ 的群消息，
 * 否则 mentionGate 根本不会问到非 @ 的消息，这里一次都不会被调用。
 */
export function createInterjectDecider(
  config: ImQQBotConfig,
  logger: Logger,
  interject: InterjectTracker,
): (ctx: { message: { kind: string; groupOpenid?: string } }) => boolean {
  return (ctx) => {
    if (!config.requireMention) return false;
    const gid = ctx.message.groupOpenid;
    if (ctx.message.kind !== 'group' || !gid) return false;
    const decision = interject.shouldInterject(gid, config.groupInterject);
    if (decision.pass) logger.info(`im-qqbot: 群 ${gid} 插话（${decision.reason}）`);
    else if (config.debug) logger.debug(`im-qqbot: 群 ${gid} 不插话（${decision.reason}）`);
    return decision.pass;
  };
}

export function setupMiddlewares(
  bot: QQBot,
  config: ImQQBotConfig,
  manager: SessionManager,
  logger: Logger,
): void {
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 群聊活跃度：只记时间戳，用来判断「群里是不是正聊着」
  const interject = createInterjectTracker();

  const mention = mentionGate({
    requireMentionInGroup: config.requireMention,
    isImplicitMention: createInterjectDecider(config, logger, interject),
  });
  const limit = rateLimiter();

  // 有效网页邀请是加白入口，必须先于访问控制；普通消息仍走下方策略。
  bot.use(async (ctx, next) => {
    const service = manager.accountAccess;
    const content = ctx.message.content
      .replaceAll(`<@!${config.appId}>`, '').replaceAll(`<@${config.appId}>`, '').trim();
    if (!service || !content || content.length > 32 || !service.isActivePairCode(content)) {
      await next();
      return;
    }
    await mention(ctx, async () => limit(ctx, async () => {
      try {
        const result = service.beginClaimFromMessage(
          ctx.replyTarget.scope, ctx.replyTarget.targetId, content,
          ctx.message.senderId, messageSenderName(ctx.message),
        );
        await ctx.bot.sendText(ctx.replyTarget, result.message);
      } catch (err) {
        logger.error(`im-qqbot: 认领处理失败: ${err instanceof Error ? err.message : String(err)}`);
        try { await ctx.bot.sendText(ctx.replyTarget, '⚠️ 认领处理失败，请稍后重试。'); } catch { /* reply best-effort */ }
      }
      ctx.stop('claim-result');
    }));
  });

  // 3. 访问控制（空名单 = 拒绝所有人，fail-closed）
  bot.use((ctx, next) => {
    const access = manager.accountAccess?.currentAccess() ?? config.access;
    return accessPolicy({
      c2c: { mode: access.c2cMode, allow: access.c2cAllow },
      group: { mode: access.groupMode, allow: access.groupAllow },
      onBlock: (_ctx, reason) => { if (config.debug) logger.debug('Access blocked: ' + reason); },
    })(ctx, next);
  });

  // 4. 群历史 — 放在门控之前，确保所有消息（含未 @bot）都记下来
  //    插件自建：结构化条目 + 消费水位 + 条数/时间双限（SDK 的 historyBuffer 已撤掉）
  bot.use(groupHistoryMiddleware({
    appId: config.appId,
    store: getGroupHistory(),
    limits: () => toHistoryLimits(config.historyLimit, config.historyMaxAgeSec),
  }));

  // 4.2 历史媒体：给只会进历史、不会触发 agent 的图片也下载本地路径
  //      （放在门控之前；下载结果挂到历史条目上，模型可以 read_image）
  bot.use(historyMediaProcessor(config, logger, getGroupHistory()));

  // 4.5 群聊活跃度：每条群消息都记一笔（包括后面会被门控挡掉的），
  //     用来判断「群里是不是在聊」；只记时间戳，和群历史是两套独立状态
  bot.use((ctx, next) => {
    if (ctx.message.kind === 'group' && ctx.message.groupOpenid) {
      interject.note(ctx.message.groupOpenid);
    }
    return next();
  });

  // 5. 群聊 @bot 门控
  bot.use(mention);

  // 6. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({
    parseFaceTags: true,
  }));

  // 7. 三层限流（sender / group / global）
  bot.use(limit);

  // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
  const slash = slashCommand({
    // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
    // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
    autoHelp: false,
    commands: buildCommandList({ manager, config, logger }),
  });
  bot.use(slash.middleware);
  bot.use(async (ctx, next) => {
    if (ctx.message.content.trim().startsWith('/')) {
      const service = manager.accountAccess;
      const error = service ? service.commandAccessError(ctx.message.senderId) : '斜杠命令服务尚未就绪。';
      await ctx.bot.sendText(ctx.replyTarget, error ?? '未知命令，请发送 /bot-help 查看可用命令。');
      ctx.stop(error ? 'slash-command-access-denied' : 'unknown-command');
      return;
    }
    await next();
  });
  // 8.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
  bot.use(questionAnswer(manager));

  // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
  //    合并批次里被并进 survivor 的消息不再单独成回合，它们的 messageId 记在
  //    survivor.state.mergedMessageIds 上，入站组包时过滤掉，避免「当前消息」和「历史」各出现一次
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
    onMerge: mergeContextBatch,
  }));

  // 10. C2C 输入状态指示
  bot.use(typingIndicator());

  // 11. 引用消息解析（记录 + 解析被引用原文）
  bot.use(quoteRef({
    maxSize: 500,
    preferMsgElements: true,
  }));

  // 11.5. 附件下载（file 附件下载到本地，供 @提及 / 工具访问）
  bot.use(attachmentProcessor(config, logger));

  // 说明：SDK 的 envelopeFormatter 不再挂载——它读的是 `h.content`，而插件的
  // 结构化历史只有 `text`，历史非空时会在中间件里抛 TypeError；插件也从未消费
  // `ctx.state.envelope`（入站自己拼 body）。
}

/**
 * concurrencyGuard 的合批回调：复刻 SDK 默认合并（正文/附件拼进第一条），
 * 额外把被合并消息的 messageId 记在 survivor 上，供入站过滤重复内容。
 */
export function mergeContextBatch(buffered: MiddlewareContext[]): MiddlewareContext {
  const [first, ...rest] = buffered;
  if (first === undefined) throw new Error('mergeContextBatch: empty batch');
  if (rest.length === 0) return first;

  const contentBearing = buffered.filter(ctx => (ctx.message.content ?? '') !== '');
  if (contentBearing.length > 0) {
    (first.message as { content?: string }).content = contentBearing
      .map(ctx => ctx.message.content)
      .join('\n');
  }
  const attachments = contentBearing.flatMap(ctx => ctx.message.attachments ?? []);
  if (attachments.length > 0) {
    (first.message as { attachments?: unknown }).attachments = attachments;
  }

  const mergedIds = rest
    .map(ctx => ctx.message.messageId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (mergedIds.length > 0) {
    (first.state as Record<string, unknown>).mergedMessageIds = mergedIds;
  }
  return first;
}
