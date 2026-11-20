import { describe, it, expect, vi } from 'vitest';
import { createInterjectDecider } from './middleware-setup.ts';
import { createInterjectTracker, type GroupInterjectConfig } from '../features/interject.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

const POLICY: GroupInterjectConfig = {
  enabled: true,
  chance: 1,
  cooldownSec: 0,
  maxPerHour: 99,
  quietHours: [],
  minRecentMessages: 1,
  activeWindowSec: 300,
};

function makeConfig(overrides: Partial<ImQQBotConfig> = {}): ImQQBotConfig {
  return {
    appId: 'app', appSecret: 'secret', requireMention: true, groupInterject: POLICY,
    ...overrides,
  } as ImQQBotConfig;
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeTracker(pass = true) {
  const tracker = createInterjectTracker({ random: () => (pass ? 0 : 1) });
  return tracker;
}

const groupCtx = (gid = 'g1') => ({ message: { kind: 'group', groupOpenid: gid } });

describe('群聊插话门控接线', () => {
  it('关掉 requireMention 时直接放行，不参与插话判定', () => {
    const tracker = makeTracker();
    const decide = createInterjectDecider(makeConfig({ requireMention: false }), makeLogger(), tracker);
    tracker.note('g1');
    expect(decide(groupCtx())).toBe(false);
  });

  it('私聊不走群聊插话', () => {
    const decide = createInterjectDecider(makeConfig(), makeLogger(), makeTracker());
    expect(decide({ message: { kind: 'c2c' } })).toBe(false);
  });

  it('群里没在聊时不插话', () => {
    const decide = createInterjectDecider(makeConfig(), makeLogger(), makeTracker());
    expect(decide(groupCtx())).toBe(false);
  });

  it('条件全过时放行，并记一次插话', () => {
    const tracker = makeTracker();
    const logger = makeLogger();
    const decide = createInterjectDecider(makeConfig(), logger, tracker);
    tracker.note('g1');
    expect(decide(groupCtx())).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('插话'));
  });

  it('策略关着时不放行', () => {
    const decide = createInterjectDecider(
      makeConfig({ groupInterject: { ...POLICY, enabled: false } }),
      makeLogger(),
      makeTracker(),
    );
    expect(decide(groupCtx())).toBe(false);
  });

  it('两个群互不影响', () => {
    const tracker = makeTracker();
    const decide = createInterjectDecider(makeConfig(), makeLogger(), tracker);
    tracker.note('g1');
    expect(decide(groupCtx('g1'))).toBe(true);
    expect(decide(groupCtx('g2'))).toBe(false);
  });
});
