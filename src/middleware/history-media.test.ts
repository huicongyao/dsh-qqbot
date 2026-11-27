import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../config.ts';
import { GroupHistoryStore, historyGroupKey } from '../features/group-history.ts';
import type { Logger } from '../types.ts';
import { historyMediaProcessor } from './history-media.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function ctx(attachments: unknown[] = [{ content_type: 'image/png', url: 'https://example/a.png', filename: 'a.png', size: 1 }]) {
  return {
    message: { kind: 'group', groupOpenid: 'g1', messageId: 'm1', attachments },
    state: {} as Record<string, unknown>,
  };
}

describe('historyMediaProcessor', () => {
  it('门控之前把图片下载下来，路径挂到历史条目上', async () => {
    const config = ConfigSchema({ appId: 'app', appSecret: 'secret' });
    const store = new GroupHistoryStore();
    store.record(historyGroupKey('app', 'g1'), {
      messageId: 'm1', senderId: 'u1', senderName: '小明', content: '',
      timestamp: new Date().toISOString(), attachments: [{ content_type: 'image/png' }],
    }, { maxMessages: 10, maxAgeMs: 60_000 });
    const download = vi.fn(async () => [{ filename: 'a.png', contentType: 'image' as const, localPath: '/m/a.png' }]);

    const middleware = historyMediaProcessor(config, logger, store, download);
    const context = ctx();
    await middleware(context as never, async () => {});

    expect(download).toHaveBeenCalledTimes(1);
    expect(store.pending(historyGroupKey('app', 'g1'), { maxMessages: 10, maxAgeMs: 60_000 })[0]?.mediaPaths)
      .toEqual(['/m/a.png']);
    expect((context.state as { historyMedia?: { files: unknown[] } }).historyMedia?.files).toHaveLength(1);
  });

  it('关掉 historyMedia 时完全不下载', async () => {
    const config = ConfigSchema({ appId: 'app', appSecret: 'secret', historyMedia: { enabled: false } });
    const store = new GroupHistoryStore();
    const download = vi.fn(async () => []);
    const middleware = historyMediaProcessor(config, logger, store, download);
    await middleware(ctx() as never, async () => {});
    expect(download).not.toHaveBeenCalled();
  });

  it('没有图片附件时直接放行', async () => {
    const config = ConfigSchema({ appId: 'app', appSecret: 'secret' });
    const store = new GroupHistoryStore();
    const download = vi.fn(async () => []);
    const middleware = historyMediaProcessor(config, logger, store, download);
    await middleware(ctx([{ content_type: 'voice' }]) as never, async () => {});
    expect(download).not.toHaveBeenCalled();
  });

  it('下载失败不阻断链路', async () => {
    const config = ConfigSchema({ appId: 'app', appSecret: 'secret' });
    const store = new GroupHistoryStore();
    const download = vi.fn(async () => { throw new Error('boom'); });
    const middleware = historyMediaProcessor(config, logger, store, download);
    let passed = false;
    await middleware(ctx() as never, async () => { passed = true; });
    expect(passed).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
