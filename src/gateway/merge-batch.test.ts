import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { mergeContextBatch } from './middleware-setup.ts';

function ctx(messageId: string, content: string, attachments: Array<{ content_type: string }> = []): MiddlewareContext {
  return {
    message: { messageId, content, attachments },
    state: {},
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as MiddlewareContext;
}

describe('mergeContextBatch', () => {
  it('复刻默认合并：正文拼进第一条、附件并进第一条', () => {
    const first = ctx('m1', '第一句');
    const second = ctx('m2', '第二句', [{ content_type: 'image/png' }]);
    const survivor = mergeContextBatch([first, second]);

    expect(survivor).toBe(first);
    expect((survivor.message as { content?: string }).content).toBe('第一句\n第二句');
    expect((survivor.message as { attachments?: unknown[] }).attachments).toHaveLength(1);
  });

  it('被合并的 messageId 记在 survivor 上，供入站过滤历史重复', () => {
    const survivor = mergeContextBatch([ctx('m1', 'a'), ctx('m2', 'b'), ctx('m3', '')]);
    expect((survivor.state as { mergedMessageIds?: string[] }).mergedMessageIds).toEqual(['m2', 'm3']);
  });

  it('单条批次原样返回', () => {
    const only = ctx('m1', 'a');
    expect(mergeContextBatch([only])).toBe(only);
    expect((only.state as { mergedMessageIds?: string[] }).mergedMessageIds).toBeUndefined();
  });
});
