import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifySessionError } from "../session/errors.js";
import { classifyContentType, isVoiceContentType, } from "./attachment.js";
import { formatHistoryTime, getGroupHistory, historyGroupKey, renderHistoryText, toHistoryLimits, } from "../features/group-history.js";
import { cleanDisplayName } from "../shared/display-name.js";
import { maskOpenid } from "../shared/openid.js";
import { normalizeMentions, rememberSelfMentions, selfMentionIds, } from "../shared/mentions.js";
import { ARCHIVED_SESSION_NOTICE, SESSION_BUSY_NOTICE } from "../shared/session-notice.js";
// ── 主处理函数 ──
/**
 * 入站失败时的用户可见提示。
 *
 * 归档与占用都要说清"消息没有处理"并给出下一步；其余失败原因未知，
 * 只说没成功、请重发，不把内部错误文本抛给用户。
 */
export function sessionFailureReply(err) {
    switch (classifySessionError(err)) {
        case 'session-archived':
            return ARCHIVED_SESSION_NOTICE;
        case 'session-busy':
            return SESSION_BUSY_NOTICE;
        default:
            return '⚠️ 这条消息没有处理成功，请稍后再发一次。\n'
                + '如果一直这样，可以在 DSH 里看看服务是否正常。';
    }
}
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(ctx, manager, config, logger, inputs, directory) {
    const msg = ctx.message;
    const mwState = ctx.state;
    const { bot } = ctx;
    const scope = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
    const replyTarget = {
        scope,
        targetId: peerId,
        msgId: msg.messageId,
    };
    // 排队期间可能有别的消息被消费、也可能有新消息到达，组装前刷新一次未消费历史。
    // 中间件拍下的快照只能保证「到达时」的状态，直接用会重复带已经进过 prompt 的消息。
    if (scope === 'group') {
        const limits = toHistoryLimits(config.historyLimit, config.historyMaxAgeSec);
        const mergedIds = mergedMessageIds(mwState);
        const store = getGroupHistory();
        const key = historyGroupKey(config.appId, peerId);
        const take = () => store
            .pending(key, limits, Date.now())
            .filter(entry => entry.messageId !== msg.messageId && !mergedIds.has(entry.messageId));
        // 历史里的图片可能还在下载（门控前的历史媒体中间件），等一小会儿再组包，
        // 否则这一轮的历史行会缺路径（下一轮才有）
        await store.settleMedia(key, take().map(entry => entry.messageId));
        mwState.history = take();
    }
    // 群成员目录：本轮发送者 + 历史里出现过的人，出站 [[at:尾号]] 靠它还原 openid
    if (scope === 'group' && directory !== undefined) {
        recordGroupMembers(directory, peerId, msg, mwState.history);
    }
    // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
    const agentBody = assembleAgentBody(msg, mwState, scope, logger, directory);
    if (!agentBody)
        return;
    logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);
    // ── 获取或创建会话 ──
    let record;
    try {
        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
    }
    catch (err) {
        logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
        // 同一会话同一种原因连续失败时只提示一次：用户刚收到过同样的说明，
        // 再刷几条只会淹没有效信息（日志仍然逐条记录）。
        const kind = classifySessionError(err);
        if (!manager.shouldNotifyFailure(scope, peerId, kind)) {
            logger.info(`failure notice suppressed (repeated ${kind}): key=${scope}:${peerId}`);
            return;
        }
        // 兜底回复：会话创建失败时告知用户，避免静默无响应
        try {
            await bot.sendMarkdown(replyTarget, sessionFailureReply(err));
        }
        catch (sendErr) {
            logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
        }
        return;
    }
    // ── 构建 UserMessage → followup ──
    const content = [{ type: 'text', text: agentBody }];
    const message = createUserMessage({
        content,
        source: { kind: 'user' },
    });
    // 按宿主保证跨边界不变的 Message.id 登记 QQ 入站，出站据此认领回合归属
    //（不在 source 上写非契约字段，也不在 SessionRecord 上抢标记）。
    inputs.register(String(message.id));
    record.agent.followup(message);
    logger.info(`→ followup sent: key=${scope}:${peerId}`);
    // 消费水位：本轮进过 prompt 的消息（历史 + 当前这条）标记为已消费，
    // 之后不再重复带；回合进行中到达、没进过 prompt 的留在池子里
    if (scope === 'group') {
        const groupId = msg.groupOpenid ?? msg.senderId;
        const mentioned = mwState.mention?.wasMentioned ?? false;
        const implicit = mwState.mention?.implicit === true && !mentioned;
        // 历史只有在被 @ 或插话时才会拼进 prompt；没拼进去的不能算已消费
        const historyIds = (mentioned || implicit ? mwState.history ?? [] : []).map(entry => entry.messageId);
        const consumed = [msg.messageId, ...mergedMessageIds(mwState), ...historyIds];
        getGroupHistory().markConsumed(historyGroupKey(config.appId, groupId), consumed);
    }
    // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
    try {
        await record.agent.whenIdle();
    }
    catch (err) {
        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
}
// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════
/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(msg, state, scope, logger, directory) {
    const isGroup = scope === 'group';
    const wasMentioned = state.mention?.wasMentioned ?? false;
    const implicit = state.mention?.implicit === true && !wasMentioned;
    const userContent = buildUserContent(msg, state, logger);
    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned || implicit))
        return null;
    // 正文里的 <@openid> 统一换掉：自己是删、认得的人给名字、认不得的只留尾号
    const normalize = buildMentionNormalizer(msg, scope, directory);
    const quotePart = buildQuotePart(state.quote);
    const now = Date.now();
    const userMessage = buildUserMessage(normalize(userContent), normalize(quotePart), msg.senderId, msg.senderName, isGroup, wasMentioned, now);
    const dynamicCtx = buildDynamicCtx(msg, state);
    const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
    const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned, implicit, normalize, now);
    return agentBody;
}
export function buildMentionNormalizer(msg, scope, directory) {
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    const groupId = msg.groupOpenid ?? msg.senderId;
    if (scope === 'group' && groupId) {
        const selfIds = mentions
            .filter(mention => mention?.is_you === true)
            .flatMap(mention => [mention.member_openid, mention.user_openid, mention.id])
            .filter((id) => typeof id === 'string' && id.length > 0);
        if (selfIds.length > 0)
            rememberSelfMentions(groupId, selfIds);
        if (directory !== undefined) {
            for (const mention of mentions) {
                // 自己（以及其他机器人）不进目录：否则模型能 @ 机器人本身
                if (mention?.is_you === true || mention?.bot === true)
                    continue;
                const id = mention?.member_openid ?? mention?.user_openid;
                if (typeof id === 'string' && id) {
                    directory.record(groupId, id, mention.nickname ?? mention.username);
                }
            }
        }
    }
    const selfIds = scope === 'group' && groupId ? selfMentionIds(groupId) : new Set();
    return (text) => normalizeMentions(text, {
        mentions,
        selfIds,
        resolveName: directory && groupId
            ? id => directory.resolve(groupId, id)?.name
            : undefined,
    });
}
/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(userContent, attachments, isGroup, wasMentioned) {
    if (userContent)
        return false;
    if (attachments && attachments.length > 0)
        return false;
    if (isGroup && wasMentioned)
        return false;
    return true;
}
/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg, state, logger) {
    const parts = [];
    const text = (msg.content ?? '').trim();
    if (text) {
        parts.push(text);
    }
    const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
    if (voiceTexts.length > 0) {
        for (const vt of voiceTexts) {
            const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
            parts.push(`[Voice message${durationTag}] ${vt.text}`);
        }
    }
    // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
    const attachmentTags = buildAttachmentTags(msg.attachments);
    if (attachmentTags) {
        parts.push(attachmentTags);
    }
    return parts.join('\n');
}
/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote) {
    if (!quote?.text && !quote?.entry?.content)
        return '';
    const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';
    return `[Quoted message begins]\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}
/**
 * Layer 3: 带发送者标签的用户消息
 */
export function buildUserMessage(userContent, quotePart, senderId, senderName, isGroup, wasMentioned, now = Date.now()) {
    if (!isGroup) {
        return `${quotePart}${userContent}`;
    }
    const mentionTag = wasMentioned ? ' (@you)' : '';
    const senderTag = formatSenderTag(senderId, senderName);
    // 当前消息也带时间：和历史行一个口径，模型才能算「刚才/多久前」
    const stamp = `[现在 ${formatHistoryTime(now, now)}] `;
    // 正文可能被清洗成空（比如只 @ 了机器人一句），别留下多余空格
    const body = userContent ? `${senderTag} ${userContent}` : senderTag;
    return `${quotePart}${stamp}${body}${mentionTag}`;
}
/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg, state) {
    const lines = [];
    if (msg.attachments && msg.attachments.length > 0) {
        const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
        const voices = [];
        // 一次遍历归类 + 生成媒体行
        for (const att of msg.attachments) {
            const kind = classifyContentType(att.content_type);
            if (kind === 'voice') {
                voices.push(att);
                continue;
            }
            const d = downloadedByFilename.get(att.filename);
            lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
        }
        // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
        if (voices.length > 0) {
            const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
            if (asrTexts.length > 0) {
                lines.push(`- ASR: ${asrTexts.join(' | ')}`);
            }
            else {
                const urls = voices.map(a => a.url).filter(Boolean);
                if (urls.length > 0)
                    lines.push(`- Voice: ${urls.join(', ')}`);
            }
        }
    }
    // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
    const quoteAttachments = state.quote?.attachments;
    if (quoteAttachments && quoteAttachments.length > 0) {
        const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
        lines.push('[Reference attachments]');
        for (const qa of quoteAttachments) {
            const kind = classifyContentType(qa.contentType);
            const d = downloadedQuote.get(qa.filename ?? '');
            if (kind === 'voice') {
                if (qa.asrText)
                    lines.push(`  - Voice: ${qa.asrText}`);
                continue;
            }
            lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
        }
    }
    return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}
/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
export function renderMediaLine(kind, filename, localPath, _url, size) {
    switch (kind) {
        case 'image':
            // 下载失败时别再回退成 URL：模型读不了 http 链接，给它只会多一次徒劳的 read_image
            return localPath ? `Image: ${localPath}` : 'Image: [图片下载失败]';
        case 'video':
            return localPath
                ? `Video: ${localPath}`
                : `Video: ${filename ?? 'video'} (download failed)`;
        case 'file':
            return localPath
                ? `File: ${localPath}`
                : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
    }
}
/**
 * 插话提示：这条没人 @ 她，是她自己凑上去的，接不接由她自己判断。
 */
const IMPLICIT_INTERJECT_HINT = '[没人叫你，你自己凑过去接的话。]';
/**
 * Layer 5: 最终 agentBody 拼合
 */
export function buildAgentBody(base, history, isGroup, wasMentioned, implicit, normalizeText, now = Date.now()) {
    // 插话时也带上群里的上下文：没人 @ 她，但她在接群里的话
    if (!isGroup || !(wasMentioned || implicit) || !history || history.length === 0) {
        return implicit ? `${IMPLICIT_INTERJECT_HINT}\n${base}` : base;
    }
    const historyLines = history.map(entry => {
        const content = renderHistoryText(entry);
        const normalized = normalizeText ? normalizeText(content) : content;
        const stamp = formatHistoryTime(entry.at, now);
        return `${stamp ? `[${stamp}] ` : ''}${formatSenderTag(entry.senderId, entry.senderName)} ${normalized}`;
    });
    return [
        '[Chat history begins]',
        ...historyLines,
        '',
        '[Chat history ends]',
        ...(implicit ? [IMPLICIT_INTERJECT_HINT] : []),
        '[Current message]',
        base,
    ].join('\n');
}
function extractVoiceTexts(attachments, processed, _logger) {
    const results = [];
    if (processed) {
        for (const pa of processed) {
            if (pa.type === 'voice' && pa.voiceText) {
                results.push({
                    text: pa.voiceText,
                    duration: pa.duration,
                    source: pa.voiceSource ?? 'stt',
                });
            }
        }
    }
    if (results.length === 0 && attachments) {
        for (const att of attachments) {
            if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
                results.push({
                    text: att.asr_refer_text.trim(),
                    source: 'asr',
                });
            }
        }
    }
    return results;
}
/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments) {
    if (!attachments || attachments.length === 0)
        return '';
    const labels = {
        image: '[图片]',
        video: '[视频]',
        file: '[文件]',
    };
    const seen = new Set();
    const tags = [];
    for (const att of attachments) {
        const kind = classifyContentType(att.content_type);
        if (kind === 'voice' || seen.has(kind))
            continue;
        seen.add(kind);
        const label = labels[kind];
        if (label)
            tags.push(label);
    }
    return tags.join(' ');
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
/** concurrencyGuard 合批时被并进当前消息的 messageId（见 middleware-setup.mergeContextBatch） */
function mergedMessageIds(state) {
    const ids = state.mergedMessageIds;
    if (!Array.isArray(ids))
        return new Set();
    return new Set(ids.filter((id) => typeof id === 'string' && id.length > 0));
}
/**
 * 把群成员（含历史里说过话的人）记进目录，只留最近出现的一批。
 *
 * groupId 必须是群 openid —— 出站时 ReplyTarget.targetId 也是它，两边必须同一个 key。
 */
export function recordGroupMembers(directory, groupId, msg, history) {
    if (typeof msg.senderId === 'string')
        directory.record(groupId, msg.senderId, msg.senderName);
    for (const entry of history ?? []) {
        if (typeof entry.senderId === 'string')
            directory.record(groupId, entry.senderId, entry.senderName);
    }
}
/**
 * 群聊里的发送者标签：[昵称 (…尾号)]。
 *
 * 只带 openid 尾号——模型能区分不同的群友（以及出站 @ 时认人），
 * 但完整 openid 不落到上下文里。没昵称时只留尾号，避免把前缀当匿名标识。
 */
function formatSenderTag(senderId, senderName) {
    const handle = maskOpenid(senderId);
    // 群名片是用户可控的：换行/超长/控制符会把消息行结构搞坏，先洗一遍
    const name = cleanDisplayName(senderName);
    return name ? `[${name} (${handle})]` : `[${handle}]`;
}
//# sourceMappingURL=inbound.js.map