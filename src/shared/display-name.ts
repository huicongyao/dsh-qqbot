/**
 * 展示名清洗（群名片 / 昵称来自用户，进 prompt 前必须收一遍）。
 *
 * 目的只有一个：别让一个群名片把 prompt 的结构搞坏。
 * 换行会被拼成新的一行、控制符会让行数错乱、超长会顶掉别人，
 * 所以统一折成单行、去控制符、限长。
 */

/** 展示名最大长度（字符，不是字节） */
export const DISPLAY_NAME_MAX = 32;

/** 控制字符 + 零宽字符 + 行/段分隔符 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;

/** 清洗展示名：折行、去控制符、压空白、限长；没有有效内容返回空串 */
export function cleanDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  // 按码点截断，别把 emoji 劈成两半
  const points = [...flat];
  return points.length > DISPLAY_NAME_MAX ? points.slice(0, DISPLAY_NAME_MAX).join('') : flat;
}
