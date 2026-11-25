import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../session/index.ts';
import { questionAnswer } from './question-answer.ts';
import { rememberSelfMentions, resetSelfMentions } from '../shared/mentions.ts';

const BOT = '3D64905DC2FAEE9CBC3459B746181935';
const ALICE = '14AB3BB2252A6528FB7C5358FA579059';

function setup(answerState = true) {
  const tryAnswer = vi.fn(() => answerState);
  const manager = { questionChannel: { tryAnswer } } as unknown as SessionManager;
  const stop = vi.fn();
  const next = vi.fn(async () => {});
  const ctx = {
    message: { content: '' },
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'msg-1' },
    stop,
  };
  return { middleware: questionAnswer(manager), tryAnswer, stop, next, ctx };
}

beforeEach(() => resetSelfMentions());

describe('questionAnswer 中间件', () => {
  it('答案正文里的 mention 先归一化再交给问题通道', async () => {
    rememberSelfMentions('group-1', [BOT]);
    const { middleware, tryAnswer, stop, next, ctx } = setup();
    ctx.message.content = `  <@${BOT}> 好的 <@${ALICE}> 也来  `;

    await middleware(ctx as never, next);

    expect(tryAnswer).toHaveBeenCalledWith('group', 'group-1', '好的 @…9059 也来');
    expect(stop).toHaveBeenCalledWith('question-answer');
    expect(next).not.toHaveBeenCalled();
  });

  it('没被截获时放行到下一个中间件', async () => {
    const { middleware, next, ctx } = setup(false);
    ctx.message.content = '随便说点';

    await middleware(ctx as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
