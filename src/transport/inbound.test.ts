import { beforeEach, describe, it, expect } from 'vitest';
import { buildAgentBody, buildMentionNormalizer, buildUserMessage, recordGroupMembers, sessionFailureReply } from './inbound.ts';
import { GroupMemberDirectory, rewriteGroupAtMentions } from '../features/at-mention.ts';
import { normalizeMentions, resetSelfMentions, selfMentionIds } from '../shared/mentions.ts';
import { SessionArchivedError, SessionBusyError } from '../session/errors.ts';

describe('sessionFailureReply', () => {
  it('归档：说清消息没处理，并给出两条下一步', () => {
    const text = sessionFailureReply(new SessionArchivedError('session-1'));

    expect(text).toContain('这条对话已经归档');
    expect(text).toContain('没有处理');
    expect(text).toContain('恢复对话');
    expect(text).toContain('新对话');
  });

  it('归档：提示里的指令用可点击标签，点一下即可发送', () => {
    const text = sessionFailureReply(new SessionArchivedError('session-1'));

    expect(text).toContain('<qqbot-cmd-input text="/unarchive"');
    expect(text).toContain('<qqbot-cmd-input text="/new"');
  });

  it('占用：说清是被另一个窗口打开着，并给出可执行动作', () => {
    const text = sessionFailureReply(new SessionBusyError('session-1'));

    expect(text).toContain('正被另一个窗口打开着');
    expect(text).toContain('没有处理');
    expect(text).toContain('再发一次');
    expect(text).toContain('<qqbot-cmd-input text="/new"');
  });

  it('其他失败：不暴露内部错误，只给重发建议', () => {
    for (const err of [new Error('EIO'), undefined]) {
      const text = sessionFailureReply(err);
      expect(text).toContain('没有处理成功');
      expect(text).toContain('再发一次');
      expect(text).not.toContain('EIO');
    }
  });

  it('文案不出现内部术语，普通用户可读', () => {
    const texts = [
      sessionFailureReply(new SessionArchivedError('session-1')),
      sessionFailureReply(new SessionBusyError('session-1')),
      sessionFailureReply(new Error('EIO')),
    ];
    for (const text of texts) {
      for (const jargon of ['写句柄', '进程', '会话归档', 'agent', 'DSH 进程']) {
        expect(text).not.toContain(jargon);
      }
    }
  });
});

describe('buildAgentBody：群聊插话（没人 @）', () => {
  const history = [
    { senderId: 'u1', senderName: '张三', content: '今天吃什么', timestamp: 1, messageId: 'm1' },
    { senderId: 'u2', senderName: '李四', content: '火锅吧', timestamp: 2, messageId: 'm2' },
  ];

  it('被 @ 时照旧带历史，不加插话提示', () => {
    const body = buildAgentBody('[张三 (u1)] 在吗 (@you)', history, true, true, false);
    expect(body).toContain('[Chat history begins]');
    expect(body).toContain('今天吃什么');
    expect(body).toContain('(@you)');
    expect(body).not.toContain('没人叫你');
  });

  it('插话时也带历史，并说明没人 @ 她', () => {
    const body = buildAgentBody('[李四 (u2)] 火锅吧', history, true, false, true);
    expect(body).toContain('[Chat history begins]');
    expect(body).toContain('火锅吧');
    expect(body).toContain('没人叫你');
    expect(body).not.toContain('(@you)');
  });

  it('插话但没历史时，只给提示不拼历史块', () => {
    const body = buildAgentBody('[李四 (u2)] 在干嘛', undefined, true, false, true);
    expect(body).not.toContain('[Chat history begins]');
    expect(body).toContain('没人叫你');
    expect(body.endsWith('[李四 (u2)] 在干嘛')).toBe(true);
  });

  it('普通群消息（没人 @ 也不插话）不拼历史', () => {
    const body = buildAgentBody('[李四 (u2)] 随便说说', history, true, false, false);
    expect(body).toBe('[李四 (u2)] 随便说说');
  });

  it('历史正文里的 <@openid> 也会被清洗（不给模型完整 ID）', () => {
    const BOT = '3D64905DC2FAEE9CBC3459B746181935';
    const ALICE = '14AB3BB2252A6528FB7C5358FA579059';
    const historyWithMentions = [
      { senderId: 'u1', senderName: '张三', content: `<@${BOT}> 叫他`, timestamp: 1, messageId: 'm1' },
      { senderId: 'u2', senderName: '李四', content: `<@${ALICE}> 来`, timestamp: 2, messageId: 'm2' },
    ];
    const normalize = (text: string) => normalizeMentions(text, { selfIds: new Set([BOT.toLowerCase()]) });
    const body = buildAgentBody('[张三 (…030E)] 在吗', historyWithMentions, true, true, false, normalize);
    expect(body).toContain('[张三 (…u1)] 叫他');
    expect(body).toContain('[李四 (…u2)] @…9059 来');
    expect(body).not.toContain(ALICE);
    expect(body).not.toContain(BOT);
  });

  it('历史里的人是打码后的尾号，不漏完整 openid', () => {
    const masked = [
      { senderId: '0488A7CE41FC01B9EA0974B3B2B3030E', senderName: '张三', content: '在吗', timestamp: 1, messageId: 'm1' },
      { senderId: '0F1E2D3C4B5A69788796A5B4C3D2E1F0', content: '在', timestamp: 2, messageId: 'm2' },
    ];
    const body = buildAgentBody('[张三 (…030E)] 叫你们', masked, true, true, false);
    expect(body).toContain('[张三 (…030E)] 在吗');
    expect(body).toContain('[…E1F0] 在');
    expect(body).not.toContain('0488A7CE41FC01B9EA0974B3B2B3030E');
    expect(body).not.toContain('0F1E2D3C4B5A69788796A5B4C3D2E1F0');
  });
});

describe('recordGroupMembers：入站记录 → 出站解析的 key 契约', () => {
  const ZHANG = '0488A7CE41FC01B9EA0974B3B2B3030E';
  const LI = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';
  const GROUP = 'group-openid-1';

  it('本轮发送者与历史里的人都进目录，按群 openid 隔离', () => {
    const directory = new GroupMemberDirectory();
    recordGroupMembers(directory, GROUP, { senderId: ZHANG, senderName: '张三' }, [
      { senderId: LI, senderName: '李四' },
    ]);

    expect(directory.members(GROUP)).toHaveLength(2);
    expect(directory.resolve(GROUP, '030E')?.openid).toBe(ZHANG);
    expect(directory.resolve('another-group', '030E')).toBeUndefined();
  });

  it('出站用同一个群 openid 就能解析出 @ 标签（两边 key 一致）', () => {
    const directory = new GroupMemberDirectory();
    recordGroupMembers(directory, GROUP, { senderId: ZHANG, senderName: '张三' });

    const r = rewriteGroupAtMentions('[[at:030E]] 来', GROUP, directory);
    expect(r.text).toBe(`<qqbot-at-user id="${ZHANG}" /> 来`);
  });

  it('缺 senderId 的脏事件不炸，也不污染目录', () => {
    const directory = new GroupMemberDirectory();
    recordGroupMembers(directory, GROUP, { senderId: undefined as unknown as string }, [
      { senderId: undefined as unknown as string, senderName: '幽灵' },
    ]);
    expect(directory.members(GROUP)).toHaveLength(0);
  });
});

describe('buildMentionNormalizer', () => {
  const BOT = '3D64905DC2FAEE9CBC3459B746181935';
  const LI = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';
  const GROUP = 'group-openid-2';

  beforeEach(() => resetSelfMentions());

  it('被 @ 的人直接记进目录（出站就能 @ 到），机器人自己不记', () => {
    const directory = new GroupMemberDirectory();
    const normalize = buildMentionNormalizer({
      mentions: [
        { member_openid: LI, nickname: '李四' },
        { member_openid: BOT, nickname: '小鲸鱼', is_you: true },
      ],
      groupOpenid: GROUP,
      senderId: LI,
    }, 'group', directory);

    expect(normalize(`<@${BOT}> <@${LI}> 来`)).toBe('@李四 来');
    expect(directory.resolve(GROUP, '李四')?.openid).toBe(LI);
    expect(directory.resolve(GROUP, '1935')).toBeUndefined();
  });

  it('自身 openid 按群缓存，历史消息没有 mentions 也能认', () => {
    buildMentionNormalizer({
      mentions: [{ member_openid: BOT, is_you: true }],
      groupOpenid: GROUP,
      senderId: LI,
    }, 'group');

    expect(selfMentionIds(GROUP).has(BOT.toLowerCase())).toBe(true);

    const historyNormalize = buildMentionNormalizer({ groupOpenid: GROUP, senderId: LI }, 'group');
    expect(historyNormalize(`旧消息 <@${BOT}> 嗯`)).toBe('旧消息 嗯');
    expect(historyNormalize('<@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA> 嗯')).toBe('@…AAAA 嗯');
  });

  it('私聊不走这群缓存，也不记目录', () => {
    const directory = new GroupMemberDirectory();
    const normalize = buildMentionNormalizer({
      mentions: [{ member_openid: BOT, is_you: true }],
      senderId: BOT,
    }, 'c2c', directory);
    expect(normalize(`<@${BOT}> 你好`)).toBe('你好');
    expect(directory.members(BOT)).toHaveLength(0);
  });
});

describe('buildUserMessage：发送者标签', () => {
  const ZHANG = '0488A7CE41FC01B9EA0974B3B2B3030E';

  it('群聊只带 openid 尾号，@ 时标注 (@you)', () => {
    const text = buildUserMessage('在吗', '', ZHANG, '张三', true, true);
    expect(text).toBe('[张三 (…030E)] 在吗 (@you)');
    expect(text).not.toContain(ZHANG);
  });

  it('没昵称时只留尾号（不拿 openid 前缀当匿名标识）', () => {
    expect(buildUserMessage('在吗', '', ZHANG, undefined, true, false)).toBe('[…030E] 在吗');
  });

  it('带引用时，引用块在发送者标签之前', () => {
    const quote = '[Quoted message begins]\n原话\n[Quoted message ends]\n[Current message]\n';
    expect(buildUserMessage('回复', quote, ZHANG, '张三', true, false)).toBe(`${quote}[张三 (…030E)] 回复`);
  });

  it('私聊不带发送者标签', () => {
    expect(buildUserMessage('在吗', '', ZHANG, '张三', false, false)).toBe('在吗');
  });

  it('群名片带换行时折成一行，不拼出假消息行', () => {
    expect(buildUserMessage('在吗', '', ZHANG, '小明\n@所有人 快来', true, true))
      .toBe('[小明 @所有人 快来 (…030E)] 在吗 (@you)');
  });

  it('正文被清洗成空（只 @ 了机器人）时不留多余空格', () => {
    expect(buildUserMessage('', '', ZHANG, '张三', true, true)).toBe('[张三 (…030E)] (@you)');
  });
});
