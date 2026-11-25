import { describe, expect, it } from 'vitest';
import { cleanDisplayName, DISPLAY_NAME_MAX } from './display-name.ts';

describe('cleanDisplayName', () => {
  it('换行、制表、控制符折成单行', () => {
    expect(cleanDisplayName('小明\n@所有人 快来')).toBe('小明 @所有人 快来');
    expect(cleanDisplayName('  a\tb  ')).toBe('a b');
    expect(cleanDisplayName('a\u200bb')).toBe('a b');
    expect(cleanDisplayName('a\r\nb')).toBe('a b');
  });

  it('空 / 非字符串返回空串', () => {
    expect(cleanDisplayName(undefined)).toBe('');
    expect(cleanDisplayName(null)).toBe('');
    expect(cleanDisplayName(42)).toBe('');
    expect(cleanDisplayName('   ')).toBe('');
  });

  it('按码点限长，不劈开 emoji', () => {
    const long = '🐳'.repeat(DISPLAY_NAME_MAX + 5);
    const cleaned = cleanDisplayName(long);
    expect([...cleaned]).toHaveLength(DISPLAY_NAME_MAX);
    expect(cleaned.endsWith('🐳')).toBe(true);
  });
});
