/**
 * 群历史（插件自建，替代 SDK 的 historyBuffer）
 *
 * 几个和 SDK 版的关键差别：
 * - 结构化条目：类型（文字/图片/表情/语音/文件）+ 发送者 + 时间，渲染时不再只剩空行
 * - 按水位消费：一条消息进过 prompt 就标 consumed，之后不再重复带；
 *   回合进行中到达、还没进过 prompt 的消息会留下（SDK 版是整块清空，会一起吞掉）
 * - 双限：条数 + 时间窗，安静群不会丢上下文，热闹群也不会把 prompt 撑爆
 *
 * 只存在进程内存里：插件重载/重启即失忆（已知并接受）。
 */
import { cleanDisplayName } from "../shared/display-name.js";
import { classifyContentType } from "../transport/attachment.js";
/** 把配置项折算成存储用的限额（时间窗至少 60 秒，避免填 0 把历史全裁掉） */
export function toHistoryLimits(historyLimit, historyMaxAgeSec) {
    // 配置可能来自 yaml/接口，NaN / 负数 / 无穷都要兜住：
    // NaN 会让时间过滤恒 false（历史永远空）或恒 true（内存不设限）
    const count = Number.isFinite(historyLimit) ? Math.floor(historyLimit) : 10;
    const ageSec = Number.isFinite(historyMaxAgeSec) ? Math.floor(historyMaxAgeSec) : 30 * 60;
    return {
        maxMessages: Math.max(1, count),
        maxAgeMs: Math.max(60, ageSec) * 1000,
    };
}
/** 按 appId 前缀隔离群历史（多账号扩展用） */
export function historyGroupKey(appId, groupId) {
    return `${appId}:${groupId}`;
}
const FACE_TAG = /<faceType=(\d+),faceId="[^"]*",ext="([^"]*)">/g;
function decodeFaceText(ext) {
    if (!ext)
        return '';
    try {
        const parsed = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'));
        const text = parsed?.text;
        return typeof text === 'string' ? text.trim() : '';
    }
    catch {
        return '';
    }
}
/**
 * 把正文里的 QQ 表情标签翻成人能读的文字。
 *
 * `faceType=1` 这类小黄脸的 `ext` 里带 text（比如「尴尬」），有就用；
 * `faceType=6` 是表情包，ext 里没有内容，统一成 `[表情]`。
 */
export function contentToText(content) {
    if (!content)
        return '';
    const replaced = content.replace(FACE_TAG, (_match, type, ext) => {
        if (type === '6')
            return '[表情]';
        return cleanDisplayName(decodeFaceText(ext)) || '[表情]';
    });
    return replaced.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
/** 判断消息类型 + 生成清洗后的正文 */
export function classifyMessage(msg) {
    const text = contentToText(msg.content);
    const attachments = msg.attachments ?? [];
    // 表情包可能同时带一张图（客户端渲染成图片），先认表情，别渲染成 [图片]
    if (/<faceType=6,/.test(msg.content ?? ''))
        return { kind: 'face', text };
    const kinds = attachments.map(att => classifyContentType(att.content_type));
    if (kinds.includes('image'))
        return { kind: 'image', text };
    if (kinds.includes('voice')) {
        const asr = attachments
            .map(att => att.asr_refer_text?.trim())
            .filter((asrText) => Boolean(asrText))
            .join(' ');
        // 语音可能既有转写文本、也有附带正文，两个都留
        return { kind: 'voice', text: [text, asr].filter(Boolean).join(' ') };
    }
    if (kinds.includes('video'))
        return { kind: 'video', text };
    if (attachments.length > 0)
        return { kind: 'file', text };
    return { kind: 'text', text };
}
/** 历史行前面那个时间：今天 `HH:mm`，昨天 `昨天 HH:mm`，更早 `MM-DD HH:mm` */
export function formatHistoryTime(at, now = Date.now()) {
    if (!Number.isFinite(at))
        return '';
    const date = new Date(at);
    const current = new Date(now);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const clock = `${hh}:${mm}`;
    if (date.toDateString() === current.toDateString())
        return clock;
    const yesterday = new Date(current);
    yesterday.setDate(current.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString())
        return `昨天 ${clock}`;
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${clock}`;
}
/** 历史正文的渲染：非文字消息给一个可读占位 */
export function renderHistoryText(entry) {
    const paths = entry.mediaPaths && entry.mediaPaths.length > 0 ? ` ${entry.mediaPaths.join(' ')}` : '';
    switch (entry.kind) {
        case 'image':
            return (entry.text ? `[图片] ${entry.text}` : '[图片]') + paths;
        case 'face':
            // 表情包可能和正文连在一起（"你好[表情]"），别把正文吞掉
            return (entry.text && entry.text !== '[表情]' ? entry.text : '[表情]') + paths;
        case 'voice':
            return (entry.text ? `[语音] ${entry.text}` : '[语音]') + paths;
        case 'video':
            return (entry.text ? `[视频] ${entry.text}` : '[视频]') + paths;
        case 'file':
            return (entry.text ? `[文件] ${entry.text}` : '[文件]') + paths;
        default:
            return entry.text + paths;
    }
}
function toStoredEntry(msg) {
    const { kind, text } = classifyMessage(msg);
    return {
        messageId: msg.messageId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        at: Date.parse(msg.timestamp ?? '') || Date.now(),
        kind,
        text,
        mediaPaths: [],
        consumed: false,
    };
}
export class GroupHistoryStore {
    groups = new Map();
    /** 在途的附件下载（key = groupId + messageId），组包前可以等一下，避免历史行缺路径 */
    mediaTasks = new Map();
    /** 记一条群消息（按 messageId 去重），顺手按时间和条数淘汰 */
    record(groupId, msg, limits, now = Date.now()) {
        const list = this.groups.get(groupId) ?? [];
        if (!list.some(entry => entry.messageId === msg.messageId)) {
            list.push(toStoredEntry(msg));
        }
        this.trim(list, limits, now);
        this.groups.set(groupId, list);
    }
    /** 还没进过 prompt 的条目（按时间升序，最多 maxMessages 条） */
    pending(groupId, limits, now = Date.now()) {
        const list = this.groups.get(groupId);
        if (list === undefined)
            return [];
        this.trim(list, limits, now);
        return list
            .filter(entry => !entry.consumed && now - entry.at <= limits.maxAgeMs)
            .slice(-limits.maxMessages)
            .map(({ consumed: _consumed, ...entry }) => entry);
    }
    /** 把已下载的附件路径挂到某条消息上（历史媒体中间件调用） */
    attachMedia(groupId, messageId, paths) {
        const list = this.groups.get(groupId);
        if (list === undefined || paths.length === 0)
            return;
        const entry = list.find(item => item.messageId === messageId);
        if (entry === undefined)
            return;
        for (const path of paths) {
            if (path && !entry.mediaPaths.includes(path))
                entry.mediaPaths.push(path);
        }
    }
    /** 登记一条在途的附件下载（下载完成会自己从表里摘掉） */
    trackMedia(groupId, messageId, task) {
        const key = `${groupId}\u0000${messageId}`;
        const tracked = task.catch(() => { }).finally(() => {
            if (this.mediaTasks.get(key) === tracked)
                this.mediaTasks.delete(key);
        });
        this.mediaTasks.set(key, tracked);
    }
    /**
     * 等这些消息的在途下载落定（有上限，不会卡住回合）。
     * 组包前调一下，历史行的路径才是齐的。
     */
    async settleMedia(groupId, messageIds, timeoutMs = 2000) {
        const tasks = [];
        for (const id of messageIds) {
            const task = this.mediaTasks.get(`${groupId}\u0000${id}`);
            if (task !== undefined)
                tasks.push(task);
        }
        if (tasks.length === 0)
            return;
        let timer;
        await Promise.race([
            Promise.allSettled(tasks).then(() => { }),
            new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
        ]);
        if (timer !== undefined)
            clearTimeout(timer);
    }
    /** 把这些消息标记为已消费（进过 prompt 就不再重复带） */
    markConsumed(groupId, messageIds) {
        const list = this.groups.get(groupId);
        if (list === undefined)
            return;
        const ids = new Set(messageIds);
        if (ids.size === 0)
            return;
        for (const entry of list) {
            if (ids.has(entry.messageId))
                entry.consumed = true;
        }
    }
    /** 当前记录条数（测试/诊断用） */
    size(groupId) {
        return this.groups.get(groupId)?.length ?? 0;
    }
    clear(groupId) {
        this.groups.delete(groupId);
    }
    trim(list, limits, now) {
        const maxAgeMs = Number.isFinite(limits.maxAgeMs) ? limits.maxAgeMs : 30 * 60 * 1000;
        // 逐条扫，不只看队头：时间戳乱序/回放的旧条目也要清掉
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (now - list[i].at > maxAgeMs)
                list.splice(i, 1);
        }
        // 已消费的条目只用来去重，不需要留太多
        const hardCap = Math.max(limits.maxMessages * 4, 20);
        while (list.length > hardCap)
            list.shift();
    }
}
let _store;
/** 进程内共享的群历史（中间件写入、入站读取并标记已消费） */
export function getGroupHistory() {
    if (_store === undefined)
        _store = new GroupHistoryStore();
    return _store;
}
/** 测试用：重置单例 */
export function resetGroupHistoryForTests() {
    _store = undefined;
}
/**
 * 群历史中间件：放在门控之前，所有群消息（含不会 @ 机器人、后面会被挡掉的）都记。
 * 取的是「本次消息之前」的未消费条目，写进 `ctx.state.history`。
 */
export function groupHistoryMiddleware(options) {
    return async (ctx, next) => {
        const { message } = ctx;
        if (message.kind !== 'group' || !message.groupOpenid) {
            await next();
            return;
        }
        const groupId = historyGroupKey(options.appId, message.groupOpenid);
        const limits = options.limits();
        const now = Date.now();
        ctx.state.history = options.store.pending(groupId, limits, now);
        options.store.record(groupId, message, limits, now);
        await next();
    };
}
//# sourceMappingURL=group-history.js.map