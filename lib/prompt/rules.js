export const RULES_SECTION_NAME = 'qqbot:rules';
export const RULES_ORDER = 400;
/** 固定通道声明：仅告知 QQ 聊天场景，不写语气与行为约束。 */
export const RULES_TEXT = '你正在 QQ 聊天中与用户对话。';
/**
 * 群聊 @ 群友的写法约定。
 *
 * 模型看不到完整 openid（prompt 里只有 …尾号），所以给它一个可写的标记，
 * 出站时由插件换成官方 `<qqbot-at-user />` 标签（见 features/at-mention.ts）。
 */
export const GROUP_AT_RULES_TEXT = [
    '群里可以主动 @ 某个群友：写 [[at:尾号]]，尾号就是对方消息里「…」后面那四位，例如 [[at:030E]]。',
    '一条消息最多 3 个；拿不准尾号就不写，写错的标记会被丢掉。',
    '也可以写 [[at:群名片]]；尾号撞车、重名或认不出的人会被丢掉，那就改用群名片。',
].join('\n');
/** 按会话类型生成规则段：群聊多一段 @ 写法，私聊不需要。 */
export function rulesText(scope) {
    return scope === 'group' ? `${RULES_TEXT}\n\n${GROUP_AT_RULES_TEXT}` : RULES_TEXT;
}
//# sourceMappingURL=rules.js.map