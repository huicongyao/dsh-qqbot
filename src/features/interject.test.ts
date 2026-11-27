import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GROUP_INTERJECT,
  createInterjectTracker,
  decideInterject,
  inQuietHours,
  type GroupInterjectConfig,
} from './interject.ts';

const ON: GroupInterjectConfig = {
  ...DEFAULT_GROUP_INTERJECT,
  enabled: true,
  chance: 0.5,
  cooldownSec: 60,
  maxPerHour: 3,
  quietHours: [1, 8],
  minRecentMessages: 3,
  activeWindowSec: 300,
};

/** 本地时间某点的毫秒时间戳（用 2026-01-01 起算，避开静默时段） */
function at(hour: number, minute = 0): number {
  return new Date(2026, 0, 5, hour, minute, 0, 0).getTime();
}

function recent(now: number, count: number, stepSec = 20): number[] {
  return Array.from({ length: count }, (_, i) => now - (count - i) * stepSec * 1000);
}

describe('inQuietHours', () => {
  it('同一天内判断', () => {
    expect(inQuietHours(2, [1, 8])).toBe(true);
    expect(inQuietHours(8, [1, 8])).toBe(false);
    expect(inQuietHours(12, [1, 8])).toBe(false);
  });

  it('跨零点判断', () => {
    expect(inQuietHours(23, [22, 6])).toBe(true);
    expect(inQuietHours(3, [22, 6])).toBe(true);
    expect(inQuietHours(12, [22, 6])).toBe(false);
  });

  it('起止相等 = 不静默', () => {
    expect(inQuietHours(3, [3, 3])).toBe(false);
    expect(inQuietHours(3, undefined)).toBe(false);
  });
});

describe('decideInterject', () => {
  const now = at(14);

  it('关着就不插', () => {
    const decision = decideInterject({
      policy: { ...ON, enabled: false }, now, hour: 14,
      recentTimes: recent(now, 5), interjectTimes: [], random: () => 0,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('关');
  });

  it('静默时段不插', () => {
    const decision = decideInterject({
      policy: ON, now, hour: 3,
      recentTimes: recent(now, 5), interjectTimes: [], random: () => 0,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('静默');
  });

  it('群里没在聊不插', () => {
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: recent(now, 2), interjectTimes: [], random: () => 0,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('没在聊');
  });

  it('窗口外的旧消息不算在聊', () => {
    const stale = [now - 10 * 60_000, now - 9 * 60_000, now - 8 * 60_000];
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: stale, interjectTimes: [], random: () => 0,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('没在聊');
  });

  it('每小时上限拦住', () => {
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: recent(now, 5),
      interjectTimes: [now - 30 * 60_000, now - 20 * 60_000, now - 10 * 60_000],
      random: () => 0,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('够多');
  });

  it('冷却中', () => {
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: recent(now, 5),
      interjectTimes: [now - 30_000],
      random: () => 0,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('冷却');
  });

  it('概率没过就不插', () => {
    let called = 0;
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: recent(now, 5), interjectTimes: [],
      random: () => { called += 1; return 0.9; },
    });
    expect(called).toBe(1);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('不插话');
  });

  it('全都过了就插', () => {
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: recent(now, 5), interjectTimes: [],
      random: () => 0.1,
    });
    expect(decision.pass).toBe(true);
  });

  it('chance = 0 永远不插，chance = 1 一定插', () => {
    const base = { now, hour: 14, recentTimes: recent(now, 5), interjectTimes: [], random: () => 0 };
    expect(decideInterject({ ...base, policy: { ...ON, chance: 0 } }).pass).toBe(false);
    expect(decideInterject({ ...base, policy: { ...ON, chance: 1 } }).pass).toBe(true);
  });
});

describe('保底触发（pityMessages）', () => {
  const now = at(14);

  it('连续攒够保底条数就强制插，不再看概率', () => {
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: recent(now, 5), interjectTimes: [],
      sinceLastInterject: 15, random: () => 0.99,
    });
    expect(decision.pass).toBe(true);
    expect(decision.reason).toContain('保底');
  });

  it('差一条不保底，照常按概率（没中）', () => {
    const decision = decideInterject({
      policy: ON, now, hour: 14,
      recentTimes: recent(now, 5), interjectTimes: [],
      sinceLastInterject: 14, random: () => 0.99,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain('这次不插话');
  });

  it('pityMessages=0 关闭保底', () => {
    const decision = decideInterject({
      policy: { ...ON, pityMessages: 0 }, now, hour: 14,
      recentTimes: recent(now, 5), interjectTimes: [],
      sinceLastInterject: 100, random: () => 0.99,
    });
    expect(decision.pass).toBe(false);
  });

  it('保底也过不了开关、静默时段和每小时上限', () => {
    const base = { now, hour: 14, recentTimes: recent(now, 5), interjectTimes: [], sinceLastInterject: 100, random: () => 0.99 };
    expect(decideInterject({ ...base, policy: { ...ON, enabled: false } }).pass).toBe(false);
    expect(decideInterject({ ...base, hour: 3, policy: ON }).pass).toBe(false);
    expect(decideInterject({ ...base, policy: { ...ON, maxPerHour: 1 }, interjectTimes: [now - 60_000] }).pass).toBe(false);
  });

  it('tracker 在第 15 条触发，触发后计数重置', () => {
    let current = now;
    const tracker = createInterjectTracker({ now: () => current, random: () => 0.99 });
    const policy = { ...ON, chance: 0, pityMessages: 15 };

    for (let i = 0; i < 14; i += 1) tracker.note('g1');
    expect(tracker.shouldInterject('g1', policy).pass).toBe(false);

    tracker.note('g1'); // 第 15 条
    const decision = tracker.shouldInterject('g1', policy);
    expect(decision.pass).toBe(true);
    expect(decision.reason).toContain('保底');

    // 冷却过后再攒 1 条，不该立刻又保底
    current += 61_000;
    tracker.note('g1');
    expect(tracker.shouldInterject('g1', policy).pass).toBe(false);
  });
});

describe('createInterjectTracker', () => {
  function setup(random = () => 0.1) {
    let current = at(14);
    const tracker = createInterjectTracker({ now: () => current, random });
    return {
      tracker,
      advance: (ms: number) => { current += ms; },
      setTime: (hour: number) => { current = at(hour); },
      now: () => current,
    };
  }

  it('记满几条群消息后才可能插话', () => {
    const { tracker } = setup();
    tracker.note('g1');
    tracker.note('g1');
    expect(tracker.shouldInterject('g1', ON).pass).toBe(false);
    tracker.note('g1');
    expect(tracker.shouldInterject('g1', ON).pass).toBe(true);
  });

  it('插过一次后走冷却', () => {
    const { tracker, advance } = setup();
    for (let i = 0; i < 3; i += 1) tracker.note('g1');
    expect(tracker.shouldInterject('g1', ON).pass).toBe(true);
    tracker.note('g1');
    expect(tracker.shouldInterject('g1', ON).pass).toBe(false);
    advance(61_000);
    tracker.note('g1');
    expect(tracker.shouldInterject('g1', ON).pass).toBe(true);
  });

  it('不同群互不影响', () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i += 1) tracker.note('g1');
    tracker.shouldInterject('g1', ON);
    tracker.note('g2');
    tracker.note('g2');
    tracker.note('g2');
    // g2 没被 g1 的冷却牵连
    expect(tracker.shouldInterject('g2', ON).pass).toBe(true);
  });

  it('一小时前的消息不算在聊', () => {
    const { tracker, advance } = setup();
    for (let i = 0; i < 3; i += 1) tracker.note('g1');
    advance(61 * 60_000);
    expect(tracker.shouldInterject('g1', ON).pass).toBe(false);
  });

  it('没通过时不记插话，不占冷却', () => {
    const { tracker } = setup(() => 0.9);
    for (let i = 0; i < 3; i += 1) tracker.note('g1');
    expect(tracker.shouldInterject('g1', ON).pass).toBe(false);
    // 换成必过，冷却里不该有记录
    const lucky = createInterjectTracker({ now: () => at(14), random: () => 0 });
    for (let i = 0; i < 3; i += 1) lucky.note('g1');
    expect(lucky.shouldInterject('g1', ON).pass).toBe(true);
  });

  it('reset 清空所有群', () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i += 1) tracker.note('g1');
    tracker.reset();
    expect(tracker.shouldInterject('g1', ON).pass).toBe(false);
  });
});
