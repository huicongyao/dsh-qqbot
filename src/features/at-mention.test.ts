import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_AT_PER_MESSAGE,
  GroupMemberDirectory,
  applyAtMentions,
  normalizeToken,
  rewriteGroupAtMentions,
  sanitizeAtMentions,
} from './at-mention.ts';

const ZHANG = '0488A7CE41FC01B9EA0974B3B2B3030E';
const LI = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';
const GROUP = 'group-openid-1';

function directory(): GroupMemberDirectory {
  const dir = new GroupMemberDirectory();
  dir.record(GROUP, ZHANG, '张三');
  dir.record(GROUP, LI, '李四');
  return dir;
}

describe('GroupMemberDirectory', () => {
  it('按尾号解析（大小写不敏感）', () => {
    const dir = directory();
    expect(dir.resolve(GROUP, '030E')?.openid).toBe(ZHANG);
    expect(dir.resolve(GROUP, '030e')?.openid).toBe(ZHANG);
    expect(dir.resolve(GROUP, '…030E')?.openid).toBe(ZHANG);
    expect(dir.resolve(GROUP, '@030E')?.openid).toBe(ZHANG);
  });

  it('按完整 openid 解析', () => {
    expect(directory().resolve(GROUP, ZHANG)?.openid).toBe(ZHANG);
  });

  it('按群名片解析', () => {
    expect(directory().resolve(GROUP, '李四')?.openid).toBe(LI);
  });

  it('认不出 / 尾号撞车 / 重名都不猜', () => {
    const dir = directory();
    expect(dir.resolve(GROUP, 'FFFF')).toBeUndefined();
    expect(dir.resolve('other-group', '030E')).toBeUndefined();
    dir.record(GROUP, 'AAAABBBBCCCC3030E', '王五');
    expect(dir.resolve(GROUP, '030E')).toBeUndefined();
    dir.record(GROUP, '1111', '张三');
    expect(dir.resolve(GROUP, '张三')).toBeUndefined();
  });

  it('同一个人重复出现刷新昵称，不重复计数', () => {
    const dir = new GroupMemberDirectory();
    dir.record(GROUP, ZHANG, '张三');
    dir.record(GROUP, ZHANG, '张三丰');
    expect(dir.members(GROUP)).toHaveLength(1);
    expect(dir.resolve(GROUP, '张三丰')?.openid).toBe(ZHANG);
    expect(dir.resolve(GROUP, '张三')).toBeUndefined();
  });

  it('每群容量满了淘汰最久没出现的', () => {
    const dir = new GroupMemberDirectory(2);
    dir.record(GROUP, 'aaaa', 'A');
    dir.record(GROUP, 'bbbb', 'B');
    dir.record(GROUP, 'aaaa', 'A'); // aaaa 变最近
    dir.record(GROUP, 'cccc', 'C'); // 淘汰 bbbb
    expect(dir.resolve(GROUP, 'A')?.openid).toBe('aaaa');
    expect(dir.resolve(GROUP, 'C')?.openid).toBe('cccc');
    expect(dir.resolve(GROUP, 'B')).toBeUndefined();
  });
});

describe('normalizeToken', () => {
  it('去掉 @ / … / 空白', () => {
    expect(normalizeToken('  @…030E ')).toBe('030E');
    expect(normalizeToken('张三')).toBe('张三');
  });
});

describe('applyAtMentions', () => {
  it('替换成官方 @ 标签', () => {
    const r = applyAtMentions('[[at:030E]] 你来', () => ZHANG);
    expect(r.text).toBe('<qqbot-at-user id="0488A7CE41FC01B9EA0974B3B2B3030E" /> 你来');
    expect(r.applied).toBe(1);
    expect(r.rejected).toEqual([]);
  });

  it('解析失败整段标记丢掉，不把内部语法漏出去', () => {
    const r = applyAtMentions('走了 [[at:FFFF]] 别等', () => undefined);
    // 丢掉标记时顺手收掉留下的空洞，别让回复读起来少字
    expect(r.text).toBe('走了 别等');
    expect(r.applied).toBe(0);
    expect(r.rejected).toEqual(['FFFF']);
  });

  it('单条超过上限的部分丢掉', () => {
    const r = applyAtMentions('[[at:a]] [[at:b]] [[at:c]] [[at:d]]', t => t.toUpperCase(), 2);
    expect(r.text).toBe('<qqbot-at-user id="A" /> <qqbot-at-user id="B" />');
    expect(r.applied).toBe(2);
    expect(r.rejected).toEqual(['c', 'd']);
  });

  it('默认上限 3', () => {
    expect(DEFAULT_MAX_AT_PER_MESSAGE).toBe(3);
  });

  it('openid 字符不安全时拒绝，不拼坏标签', () => {
    const r = applyAtMentions('[[at:x]]', () => 'a" /><script>');
    expect(r.text).toBe('');
    expect(r.rejected).toEqual(['x']);
  });

  it('不跨行吞内容', () => {
    const r = applyAtMentions('[[at:a\nb]]', t => t);
    expect(r.text).toBe('[[at:a\nb]]');
  });

  it('大小写不敏感', () => {
    const r = applyAtMentions('[[AT:030E]] 来', () => ZHANG);
    expect(r.applied).toBe(1);
    expect(r.text).toBe(`<qqbot-at-user id="${ZHANG}" /> 来`);
  });

  it('照抄「名字 (…尾号)」也能认', () => {
    const r = rewriteGroupAtMentions('[[at:张三 (…030E)]] 来', GROUP, directory());
    expect(r.applied).toBe(1);
    expect(r.text).toBe(`<qqbot-at-user id="${ZHANG}" /> 来`);
  });

  it('代码块与行内代码里的写法不替换（模型展示语法时不该变成真 @）', () => {
    const text = ['写法是：', '```', '[[at:030E]]', '```', '或者 `[[at:030E]]` 这样', '结尾 [[at:030E]]'].join('\n');
    const r = rewriteGroupAtMentions(text, GROUP, directory());
    expect(r.applied).toBe(1);
    expect(r.text).toContain('```\n[[at:030E]]\n```');
    expect(r.text).toContain('`[[at:030E]]`');
    expect(r.text).toMatch(/结尾 <qqbot-at-user id="0488A7CE41FC01B9EA0974B3B2B3030E" \/>$/);
  });

  it('标记写在行首时不留前导空格', () => {
    const r = applyAtMentions('[[at:FFFF]] 你来', () => undefined);
    expect(r.text).toBe('你来');
  });

  it('丢标记时不碰代码块缩进', () => {
    const text = ['[[at:FFFF]] 看：', '```', '    if (x) {', '        y();', '    }', '```'].join('\n');
    const r = applyAtMentions(text, () => undefined);
    expect(r.text).toBe(['看：', '```', '    if (x) {', '        y();', '    }', '```'].join('\n'));
  });

  it('没有要丢的标记时不动正文空白', () => {
    expect(applyAtMentions('a    b', token => token).text).toBe('a    b');
  });

  it('accepts 完整 openid 和群名片两种写法', () => {
    const dir = directory();
    const r = rewriteGroupAtMentions('[[at:0488A7CE41FC01B9EA0974B3B2B3030E]] [[at:李四]]', GROUP, dir);
    expect(r.applied).toBe(2);
    expect(r.text).toBe('<qqbot-at-user id="0488A7CE41FC01B9EA0974B3B2B3030E" /> <qqbot-at-user id="0F1E2D3C4B5A69788796A5B4C3D2E1F0" />');
  });

  it('sanitizeAtMentions：删掉没换成的标记，但保留代码块里的示例', () => {
    const dirty = ['走了 [[at:FFFF]] 别等', '```', '[[at:030E]]', '```'].join('\n');
    expect(sanitizeAtMentions(dirty)).toBe(['走了 别等', '```', '[[at:030E]]', '```'].join('\n'));
    expect(sanitizeAtMentions('没有标记')).toBe('没有标记');
  });

  it('别的群的尾号在本群解析不出来', () => {
    const dir = new GroupMemberDirectory();
    dir.record('other-group', ZHANG, '张三');
    const r = rewriteGroupAtMentions('[[at:030E]]', GROUP, dir);
    expect(r.text).toBe('');
    expect(r.rejected).toEqual(['030E']);
  });
});
