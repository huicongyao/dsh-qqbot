import { cacheMsgId } from "../transport/msgid-cache.js";
import { normalizeMentions, selfMentionIds } from "../shared/mentions.js";
export function questionAnswer(manager) {
    return async (ctx, next) => {
        const questionChannel = manager.questionChannel;
        if (!questionChannel) {
            await next();
            return;
        }
        // 答案正文同样会进工具结果给模型看：不能把完整 openid 带进去
        const answer = normalizeMentions(ctx.message.content.trim(), {
            mentions: ctx.message.mentions,
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
//# sourceMappingURL=question-answer.js.map