/**
 * 正文里的 QQ mention 标记（`<@openid>` / `<@!appId>`）归一化。
 *
 * 平台把「谁 @ 了谁」直接拼进正文，且在 `mentions` 数组里给了 `is_you` 与昵称。
 * prompt 里不该出现完整 openid，所以这里统一换成：
 *   - @ 机器人自己 → 删掉（正文外的 `(@you)` 已经标过）
 *   - 认得的人 → `@昵称`
 *   - 认不出的 openid → `@…尾号`（与发送者标签一个口径）
 */
import { cleanDisplayName } from "./display-name.js";
import { maskOpenid } from "./openid.js";
/** 正文里的 mention 标记；id 不含空白与尖括号 */
const MENTION_TAG_SOURCE = '<@!?([^<>\\s]+)>';
/** 被删掉的标记先换成它，最后按「附近有没有空白」收拾，避免全局折叠把代码缩进吃掉 */
export const REMOVED_MARKER = '\u0000';
/** 每个群记住「机器人自己」的 openid：正文里出现时直接删 */
const selfIdsByGroup = new Map();
/** 记下机器人自己在某个群的 openid（来自 mentions[].is_you） */
export function rememberSelfMentions(groupId, ids) {
    if (!groupId || ids.length === 0)
        return;
    let set = selfIdsByGroup.get(groupId);
    if (set === undefined) {
        set = new Set();
        selfIdsByGroup.set(groupId, set);
    }
    for (const id of ids) {
        const value = id.trim();
        if (value)
            set.add(value.toLowerCase());
    }
}
/** 该群已知的机器人自身 openid（小写） */
export function selfMentionIds(groupId) {
    return selfIdsByGroup.get(groupId) ?? new Set();
}
/** 测试用：清掉记住的自身 openid */
export function resetSelfMentions() {
    selfIdsByGroup.clear();
}
/** 带省略号打码的 id（与发送者标签同一写法） */
function maskId(id) {
    return /^[0-9A-Za-z_-]{8,}$/.test(id) ? maskOpenid(id) : id;
}
/**
 * 收拾被删掉的标记（`REMOVED_MARKER`）：
 *
 * - 标记两侧有空白 → 收成一个空格；紧贴文字 → 直接消失
 * - 删完变空的行去空白；整段开头空出来的第一行去掉
 * - 只处理含标记的行，别的行（含代码块缩进）一个字符都不动
 */
export function collapseRemovedMarkers(text) {
    if (!text.includes(REMOVED_MARKER))
        return text;
    const lines = [];
    for (const line of text.split('\n')) {
        if (!line.includes(REMOVED_MARKER)) {
            lines.push({ text: line, emptied: false });
            continue;
        }
        const cleaned = line
            .replace(/([ \t]*)\u0000+([ \t]*)/g, (_match, before, after) => (before || after ? ' ' : ''))
            .replace(/^[ \t]+/, '')
            .replace(/[ \t]+$/, '');
        // 整行只剩被删的标记（比如消息以 @机器人 开头）→ 这行本来就是空的
        lines.push({ text: cleaned, emptied: cleaned === '' });
    }
    // 只吃掉开头因为删除而空出来的行，正文里原本就有的空行保留
    while (lines.length > 0 && lines[0]?.emptied)
        lines.shift();
    return lines.map(line => line.text).join('\n');
}
/**
 * 归一化正文里的 mention 标记。
 *
 * 删掉自身 mention 后只收拾被删位置，不做全局空白折叠——正文里的缩进、
 * 表格对齐、Markdown 两空格换行都不该被碰到。
 */
export function normalizeMentions(text, options = {}) {
    if (!text.includes('<@'))
        return text;
    const selfIds = options.selfIds ?? new Set();
    const byId = new Map();
    for (const mention of options.mentions ?? []) {
        for (const id of [mention.member_openid, mention.user_openid, mention.id]) {
            if (typeof id === 'string' && id)
                byId.set(id.toLowerCase(), mention);
        }
    }
    let removed = false;
    const normalized = text.replace(new RegExp(MENTION_TAG_SOURCE, 'g'), (_match, rawId) => {
        const id = rawId.trim();
        const lower = id.toLowerCase();
        if (selfIds.has(lower)) {
            removed = true;
            return REMOVED_MARKER;
        }
        const mention = byId.get(lower);
        if (mention?.is_you === true) {
            removed = true;
            return REMOVED_MARKER;
        }
        const name = cleanDisplayName(mention?.nickname ?? mention?.username)
            || cleanDisplayName(options.resolveName?.(id));
        return name ? `@${name}` : `@${maskId(id)}`;
    });
    return removed ? collapseRemovedMarkers(normalized) : normalized;
}
//# sourceMappingURL=mentions.js.map