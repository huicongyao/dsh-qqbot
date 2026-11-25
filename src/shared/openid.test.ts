import { describe, expect, it } from 'vitest';
import { isSafeOpenid, maskOpenid } from './openid.ts';

describe('maskOpenid', () => {
  it('只留后四位，前面打码', () => {
    expect(maskOpenid('0488A7CE41FC01B9EA0974B3B2B3030E')).toBe('…030E');
    expect(maskOpenid('AAABBBCCCDDD')).toBe('…CDDD');
  });

  it('短 id 与空串不炸', () => {
    expect(maskOpenid('ab')).toBe('…ab');
    expect(maskOpenid('')).toBe('…');
  });

  it('去掉两端空白', () => {
    expect(maskOpenid('  0488A7CE41FC01B9EA0974B3B2B3030E  ')).toBe('…030E');
  });
});

describe('isSafeOpenid', () => {
  it('只接受可安全拼进标签的字符', () => {
    expect(isSafeOpenid('0488A7CE41FC01B9EA0974B3B2B3030E')).toBe(true);
    expect(isSafeOpenid('a-b_c')).toBe(true);
    expect(isSafeOpenid('x" onerror="')).toBe(false);
    expect(isSafeOpenid('<script>')).toBe(false);
    expect(isSafeOpenid('')).toBe(false);
    expect(isSafeOpenid('a'.repeat(65))).toBe(false);
  });
});
