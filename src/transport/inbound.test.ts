import { describe, it, expect } from 'vitest';
import { buildAgentBody, sessionFailureReply } from './inbound.ts';
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
    expect(body).not.toContain('你是自己接话的');
  });

  it('插话时也带历史，并说明没人 @ 她', () => {
    const body = buildAgentBody('[李四 (u2)] 火锅吧', history, true, false, true);
    expect(body).toContain('[Chat history begins]');
    expect(body).toContain('火锅吧');
    expect(body).toContain('你是自己接话的');
    expect(body).not.toContain('(@you)');
  });

  it('插话但没历史时，只给提示不拼历史块', () => {
    const body = buildAgentBody('[李四 (u2)] 在干嘛', undefined, true, false, true);
    expect(body).not.toContain('[Chat history begins]');
    expect(body).toContain('你是自己接话的');
    expect(body.endsWith('[李四 (u2)] 在干嘛')).toBe(true);
  });

  it('普通群消息（没人 @ 也不插话）不拼历史', () => {
    const body = buildAgentBody('[李四 (u2)] 随便说说', history, true, false, false);
    expect(body).toBe('[李四 (u2)] 随便说说');
  });
});
