import { describe, expect, it, beforeEach } from 'vitest';
import { normalizeMentions, rememberSelfMentions, resetSelfMentions, selfMentionIds } from './mentions.ts';

const BOT = '3D64905DC2FAEE9CBC3459B746181935';
const ALICE = '14AB3BB2252A6528FB7C5358FA579059';
const BOB = 'FF5EAF8ADE954A2EF317196EB0137C9B';

beforeEach(() => resetSelfMentions());

describe('normalizeMentions', () => {
  it('删掉机器人自己的 mention，并收掉留下的空档', () => {
    expect(normalizeMentions(`<@${BOT}> 再艾特他一次`, { selfIds: new Set([BOT.toLowerCase()]) }))
      .toBe('再艾特他一次');
    expect(normalizeMentions(`说话<@${BOT}>`, { selfIds: new Set([BOT.toLowerCase()]) })).toBe('说话');
  });

  it('认得的 mention 换成昵称', () => {
    expect(normalizeMentions(`<@${ALICE}> 来`, { mentions: [{ member_openid: ALICE, nickname: '{x|x∈R}' }] }))
      .toBe('@{x|x∈R} 来');
  });

  it('mention 里的 is_you 也当作自己删掉（不依赖缓存）', () => {
    expect(normalizeMentions(`<@${BOT}> 你好`, { mentions: [{ member_openid: BOT, is_you: true }] }))
      .toBe('你好');
  });

  it('认不出的 openid 只留尾号', () => {
    expect(normalizeMentions(`<@${ALICE}> 来`, {})).toBe('@…9059 来');
  });

  it('回退到目录解析名字', () => {
    expect(normalizeMentions(`<@${BOB}> 来`, { resolveName: id => (id === BOB ? '老鲍' : undefined) }))
      .toBe('@老鲍 来');
  });

  it('昵称空串 / 只有空白的 mentions 不覆盖回退名字', () => {
    expect(normalizeMentions(`<@${BOB}> 来`, { mentions: [{ member_openid: BOB, nickname: '  ' }], resolveName: () => '老鲍' }))
      .toBe('@老鲍 来');
  });

  it('非 openid 形态的 id（如数字 appId）原样保留', () => {
    expect(normalizeMentions('<@!123456> hi', {})).toBe('@123456 hi');
  });

  it('多个 mention 一起处理，且不碰普通文本', () => {
    const text = `<@${BOT}> <@${ALICE}> <@${BOB}> 都来`;
    expect(normalizeMentions(text, { selfIds: new Set([BOT.toLowerCase()]) })).toBe('@…9059 @…7C9B 都来');
  });

  it('没有 mention 时原样返回', () => {
    expect(normalizeMentions('普通消息 <@>')).toBe('普通消息 <@>');
  });

  it('昵称里的换行/控制符被洗掉，不会拼出假消息行', () => {
    expect(normalizeMentions(`<@${ALICE}> 来`, { mentions: [{ member_openid: ALICE, nickname: '小明\n@所有人 快来' }] }))
      .toBe('@小明 @所有人 快来 来');
  });

  it('删自身 mention 后不吃代码块缩进', () => {
    const text = `<@${BOT}> 看这个：\n\`\`\`\n    if (x) {\n        y();\n    }\n\`\`\``;
    const out = normalizeMentions(text, { selfIds: new Set([BOT.toLowerCase()]) });
    expect(out).toBe('看这个：\n\`\`\`\n    if (x) {\n        y();\n    }\n\`\`\`');
  });

  it('保留正文里本来就有的大段空白（没删东西就不收拾）', () => {
    const text = 'a    b';
    expect(normalizeMentions(text, {})).toBe(text);
  });

  it('自身 mention 在行首且后面换行时，不留前导空行', () => {
    expect(normalizeMentions(`<@${BOT}>\n再来`, { selfIds: new Set([BOT.toLowerCase()]) })).toBe('再来');
  });

  it('紧贴文字的自 mention 删除后不额外加空格', () => {
    expect(normalizeMentions(`a<@${BOT}>b`, { selfIds: new Set([BOT.toLowerCase()]) })).toBe('ab');
  });

  it('两处自身 mention 之间只留一个空格', () => {
    expect(normalizeMentions(`<@${BOT}> <@${BOT}> 来`, { selfIds: new Set([BOT.toLowerCase()]) })).toBe('来');
  });
});

describe('self mention 缓存', () => {
  it('按群记住机器人自己的 openid', () => {
    rememberSelfMentions('group-1', [BOT, '  ']);
    expect(selfMentionIds('group-1').has(BOT.toLowerCase())).toBe(true);
    expect(selfMentionIds('group-2').size).toBe(0);
  });

  it('历史消息没有 mentions 时靠缓存也能认出自 @', () => {
    rememberSelfMentions('group-1', [BOT]);
    const normalize = (text: string) => normalizeMentions(text, { selfIds: selfMentionIds('group-1') });
    expect(normalize(`[旧消息] <@${BOT}> 嗯`)).toBe('[旧消息] 嗯');
  });
});
