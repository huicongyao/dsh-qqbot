import { beforeEach, describe, expect, it } from 'vitest';
import {
  GroupHistoryStore,
  classifyMessage,
  contentToText,
  formatHistoryTime,
  groupHistoryMiddleware,
  historyGroupKey,
  renderHistoryText,
  resetGroupHistoryForTests,
  toHistoryLimits,
} from './group-history.ts';

const LIMITS = { maxMessages: 3, maxAgeMs: 60 * 60 * 1000 };
const NOW = new Date(2026, 0, 1, 9, 5).getTime();

const msg = (messageId: string, content: string, overrides?: Partial<{ senderId: string; senderName: string; at: number; attachments: Array<{ content_type: string }> }>) => ({
  messageId,
  senderId: overrides?.senderId ?? 'u1',
  senderName: overrides?.senderName ?? '张三',
  content,
  timestamp: new Date(overrides?.at ?? NOW - 60_000).toISOString(),
  attachments: overrides?.attachments,
});

beforeEach(() => resetGroupHistoryForTests());

describe('contentToText / classifyMessage', () => {
  it('faceType=6 表情包翻成 [表情]', () => {
    expect(contentToText('<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">')).toBe('[表情]');
  });

  it('faceType=1 用 ext 里的文字（坐标）', () => {
    expect(contentToText('水群2.8 <faceType=1,faceId="10",ext="eyJ0ZXh0Ijoi5bC05bCsIn0=">')).toBe('水群2.8 尴尬');
  });

  it('按附件判类型', () => {
    expect(classifyMessage(msg('m', '', { attachments: [{ content_type: 'image/png' }] })).kind).toBe('image');
    expect(classifyMessage(msg('m', '', { attachments: [{ content_type: 'voice' }] })).kind).toBe('voice');
    expect(classifyMessage(msg('m', '', { attachments: [{ content_type: 'audio/silk' }] })).kind).toBe('voice');
    expect(classifyMessage(msg('m', '', { attachments: [{ content_type: 'video/mp4' }] })).kind).toBe('video');
    expect(classifyMessage(msg('m', '纯文字')).kind).toBe('text');
  });

  it('表情包即使带图附件也判成表情', () => {
    const classified = classifyMessage(msg('m', '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">', { attachments: [{ content_type: 'image/gif' }] }));
    expect(classified.kind).toBe('face');
    expect(renderHistoryText(classified)).toBe('[表情]');
  });

  it('表情包和正文连写时正文不丢', () => {
    const classified = classifyMessage(msg('m', '你好<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'));
    expect(classified.kind).toBe('face');
    expect(classified.text).toBe('你好[表情]');
    expect(renderHistoryText(classified)).toBe('你好[表情]');
  });

  it('兼容 QQ 的裸 content_type（image / voice / video）', () => {
    expect(classifyMessage(msg('m', '', { attachments: [{ content_type: 'image' }] })).kind).toBe('image');
    expect(classifyMessage(msg('m', '', { attachments: [{ content_type: 'voice' }] })).kind).toBe('voice');
    expect(classifyMessage(msg('m', '', { attachments: [{ content_type: 'video' }] })).kind).toBe('video');
  });

  it('语音历史带上 ASR 文本', () => {
    const classified = classifyMessage(msg('m', '', {
      attachments: [{ content_type: 'voice', asr_refer_text: '晚安' }],
    }));
    expect(classified).toEqual({ kind: 'voice', text: '晚安' });
    expect(renderHistoryText(classified)).toBe('[语音] 晚安');
  });

  it('非法配置兜底成默认值（NaN 不会让历史永远空、内存不设限）', () => {
    expect(toHistoryLimits(Number.NaN, Number.NaN)).toEqual({ maxMessages: 10, maxAgeMs: 30 * 60 * 1000 });
    expect(toHistoryLimits(-5, 0)).toEqual({ maxMessages: 1, maxAgeMs: 60 * 1000 });
  });
});

describe('formatHistoryTime', () => {
  const at = (h: number, m: number, dayOffset = 0) => {
    const d = new Date(2026, 0, 1, h, m);
    d.setDate(d.getDate() - dayOffset);
    return d.getTime();
  };

  it('今天只给 HH:mm', () => {
    expect(formatHistoryTime(at(8, 30), NOW)).toBe('08:30');
  });

  it('昨天加前缀', () => {
    expect(formatHistoryTime(at(23, 10, 1), NOW)).toBe('昨天 23:10');
  });

  it('更早给 MM-DD', () => {
    expect(formatHistoryTime(at(23, 10, 3), NOW)).toBe('12-29 23:10');
  });
});

describe('renderHistoryText', () => {
  it('非文字消息给可读占位', () => {
    expect(renderHistoryText({ kind: 'image', text: '', mediaPaths: [] })).toBe('[图片]');
    expect(renderHistoryText({ kind: 'face', text: '', mediaPaths: [] })).toBe('[表情]');
    expect(renderHistoryText({ kind: 'voice', text: '', mediaPaths: [] })).toBe('[语音]');
    expect(renderHistoryText({ kind: 'file', text: '', mediaPaths: [] })).toBe('[文件]');
    expect(renderHistoryText({ kind: 'video', text: '', mediaPaths: [] })).toBe('[视频]');
    expect(renderHistoryText({ kind: 'text', text: '在吗', mediaPaths: [] })).toBe('在吗');
  });

  it('带本地路径时渲染到行内，模型可以 read_image', () => {
    expect(renderHistoryText({ kind: 'image', text: '', mediaPaths: ['/m/a.png'] })).toBe('[图片] /m/a.png');
    expect(renderHistoryText({ kind: 'face', text: '', mediaPaths: ['/m/s.gif'] })).toBe('[表情] /m/s.gif');
    expect(renderHistoryText({ kind: 'face', text: '你好[表情]', mediaPaths: ['/m/s.gif'] })).toBe('你好[表情] /m/s.gif');
  });
});

describe('GroupHistoryStore', () => {
  it('按 messageId 去重', () => {
    const store = new GroupHistoryStore();
    store.record('g', msg('m1', '在吗'), LIMITS, NOW);
    store.record('g', msg('m1', '在吗'), LIMITS, NOW);
    expect(store.size('g')).toBe(1);
    expect(store.pending('g', LIMITS, NOW)).toHaveLength(1);
  });

  it('pending 只给未消费的，且最多 maxMessages 条', () => {
    const store = new GroupHistoryStore();
    for (let i = 1; i <= 5; i += 1) store.record('g', msg('m' + i, '内容' + i), LIMITS, NOW);
    const pending = store.pending('g', LIMITS, NOW);
    expect(pending.map(e => e.messageId)).toEqual(['m3', 'm4', 'm5']);
  });

  it('消费水位：进过 prompt 的不再带；回合中到达的留下', () => {
    const store = new GroupHistoryStore();
    store.record('g', msg('m1', '第一句'), LIMITS, NOW);
    expect(store.pending('g', LIMITS, NOW).map(e => e.messageId)).toEqual(['m1']);

    store.markConsumed('g', ['m1']);
    // 回合进行中新到一条
    store.record('g', msg('m2', '第二句'), LIMITS, NOW);
    expect(store.pending('g', LIMITS, NOW).map(e => e.messageId)).toEqual(['m2']);
  });

  it('attachMedia 把本地路径挂到对应消息上（去重）', () => {
    const store = new GroupHistoryStore();
    store.record('g', msg('m1', '看这个', { attachments: [{ content_type: 'image/png' }] }), LIMITS, NOW);
    store.attachMedia('g', 'm1', ['/m/a.png', '/m/b.png', '/m/a.png']);
    const [entry] = store.pending('g', LIMITS, NOW);
    expect(entry?.mediaPaths).toEqual(['/m/a.png', '/m/b.png']);
  });

  it('超过时间窗的条目不再带，并从存储里清掉', () => {
    const store = new GroupHistoryStore();
    store.record('g', msg('old', '很久以前', { at: NOW - 2 * 60 * 60 * 1000 }), LIMITS, NOW);
    expect(store.pending('g', LIMITS, NOW)).toEqual([]);
    expect(store.size('g')).toBe(0);
  });

  it('settleMedia 等在途下载落定后再返回', async () => {
    const store = new GroupHistoryStore();
    let finish!: () => void;
    const task = new Promise<void>((resolve) => { finish = resolve; });
    store.trackMedia('g', 'm1', task);

    let settled = false;
    const waiting = store.settleMedia('g', ['m1'], 1000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await waiting;
    expect(settled).toBe(true);
  });

  it('settleMedia 超时也会返回，不卡住回合', async () => {
    const store = new GroupHistoryStore();
    store.trackMedia('g', 'm1', new Promise<void>(() => {}));
    const started = Date.now();
    await store.settleMedia('g', ['m1'], 30);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('时间窗淘汰逐条扫，乱序的旧条目也会被清掉', () => {
    const store = new GroupHistoryStore();
    store.record('g', msg('old', '旧消息', { at: NOW - 2 * 60 * 60 * 1000 }), LIMITS, NOW);
    store.record('g', msg('new', '新消息', { at: NOW - 60_000 }), LIMITS, NOW);
    expect(store.pending('g', LIMITS, NOW).map(e => e.messageId)).toEqual(['new']);
    expect(store.size('g')).toBe(1);
  });

  it('存储有条数硬上限，避免一直没人消费时无限增长', () => {
    const store = new GroupHistoryStore();
    const limits = { maxMessages: 2, maxAgeMs: 60 * 60 * 1000 };
    for (let i = 0; i < 30; i += 1) store.record('g', msg('m' + i, 'x'), limits, NOW);
    expect(store.size('g')).toBeLessThanOrEqual(20);
  });
});

describe('groupHistoryMiddleware', () => {
  const makeCtx = (messageId: string, content: string) => ({
    message: {
      kind: 'group',
      groupOpenid: 'g1',
      messageId,
      senderId: 'u1',
      senderName: '张三',
      content,
      // 中间件内部用 Date.now() 判断时间窗，这里给当前时间
      timestamp: new Date().toISOString(),
    },
    state: {} as Record<string, unknown>,
  });

  it('先给未消费的历史，再把当前这条记进去', async () => {
    const store = new GroupHistoryStore();
    const middleware = groupHistoryMiddleware({ appId: 'app', store, limits: () => LIMITS });

    const first = makeCtx('m1', '在吗');
    await middleware(first, async () => {});
    expect(first.state.history).toEqual([]);

    const second = makeCtx('m2', '在的');
    await middleware(second, async () => {});
    const history = second.state.history as Array<{ messageId: string }>;
    expect(history.map(e => e.messageId)).toEqual(['m1']);

    // 当前这条也进了存储，等下一轮才会被带
    expect(store.size(historyGroupKey('app', 'g1'))).toBe(2);
  });

  it('非群聊不记录', async () => {
    const store = new GroupHistoryStore();
    const middleware = groupHistoryMiddleware({ appId: 'app', store, limits: () => LIMITS });
    const ctx = { message: { kind: 'c2c', messageId: 'm1', senderId: 'u1', content: '在吗' }, state: {} as Record<string, unknown> };
    await middleware(ctx as never, async () => {});
    expect(store.size(historyGroupKey('app', 'g1'))).toBe(0);
  });
});
