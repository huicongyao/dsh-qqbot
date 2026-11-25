/**
 * 出站 @ 群成员。
 *
 * 官方在群 markdown 消息里支持 `<qqbot-at-user id="成员 member_openid" />`，
 * 会渲染成真正的 @ 标签（见官方「文本交互」文档）。模型看不到完整 openid
 * （prompt 里只给 `…尾号`），所以约定：模型写 `[[at:尾号]]`，出站换成官方标签。
 *
 * 只在群聊生效。解析不到 / 超过单条上限的标记整段丢掉——宁可不 @，
 * 也不把 `[[at:...]]` 这种内部语法漏给用户；代码块与行内代码里不替换
 * （模型要展示语法时不该被渲染成真 @）。
 */
import { cleanDisplayName } from '../shared/display-name.ts';
import { isSafeOpenid } from '../shared/openid.ts';
import { collapseRemovedMarkers, REMOVED_MARKER } from '../shared/mentions.ts';

/** 目录里的一个群成员 */
export interface GroupMember {
  readonly openid: string;
  readonly name?: string;
  readonly lastSeen: number;
}

/** 标记最多认 100 字符的 token（够长到容纳「张三 (…030E)」这种照抄） */
const TOKEN_SOURCE = '\\[\\[at:([^\\]\\n]{1,100})\\]\\]';
/** 代码块 / 行内代码：只有普通段参与替换与清理 */
const CODE_SPAN_SOURCE = '(```[\\s\\S]*?```|`[^`\\n]*`)';

/** 单条消息最多 @ 几个人（超过的部分丢掉） */
export const DEFAULT_MAX_AT_PER_MESSAGE = 3;

/**
 * 群成员目录：按群记住「见过的人」。
 *
 * openid 只在插件内部保存：群里 @ 需要的是 member_openid，而 prompt 只给尾号，
 * 所以出站时要靠这张表把尾号还原成 openid。按群隔离——同一个人的
 * member_openid 在不同群并不相同。
 *
 * 只在进程内存里：插件重启/热重载后目录清空，模型若照旧写旧尾号会被丢掉，
 * 直到该群有人再说话。这是有意的（不落盘就没有跨进程的身份泄漏面）。
 */
export class GroupMemberDirectory {
  private readonly groups = new Map<string, Map<string, GroupMember>>();
  private readonly capacityPerGroup: number;
  private readonly maxGroups: number;

  /**
   * @param capacityPerGroup 每群最多记多少人（超出淘汰最久没说话的）
   * @param maxGroups 最多同时记多少个群，超过时清掉整天没人说话的群
   */
  public constructor(capacityPerGroup = 200, maxGroups = 500) {
    this.capacityPerGroup = Math.max(1, Math.floor(capacityPerGroup));
    this.maxGroups = Math.max(1, Math.floor(maxGroups));
  }

  /** 记录一个群成员（同一个人重复出现只刷新昵称与时间） */
  public record(groupId: string, openid: string, name?: string): void {
    if (typeof groupId !== 'string' || typeof openid !== 'string') return;
    const group = groupId.trim();
    const id = openid.trim();
    if (!group || !id) return;
    let members = this.groups.get(group);
    if (members === undefined) {
      members = new Map();
      this.groups.set(group, members);
    }
    const nickname = cleanDisplayName(name) || members.get(id)?.name;
    // 先删后插：Map 的插入顺序就是淘汰顺序（最久没出现的在最前）
    members.delete(id);
    members.set(id, { openid: id, name: nickname, lastSeen: Date.now() });
    while (members.size > this.capacityPerGroup) {
      const oldest = members.keys().next().value;
      if (oldest === undefined) break;
      members.delete(oldest);
    }
    this.pruneGroups();
  }

  /** 该群当前记得的人（按最近出现排序，新的在后） */
  public members(groupId: string): GroupMember[] {
    return [...(this.groups.get(groupId)?.values() ?? [])];
  }

  /**
   * 把模型给的 token 解析成 openid。
   * 依次认：完整 openid → openid 尾号（≥4 位）→ 群名片。
   * 命中多个（尾号撞车 / 重名）就当作解析失败，不去猜。
   */
  public resolve(groupId: string, token: string): GroupMember | undefined {
    const members = this.groups.get(groupId);
    const normalized = normalizeToken(token);
    if (members === undefined || !normalized) return undefined;

    const lower = normalized.toLowerCase();
    const idShaped = /^[0-9a-f]{4,64}$/.test(lower);
    const hits: GroupMember[] = [];
    const seen = new Set<string>();
    const push = (member: GroupMember): void => {
      if (seen.has(member.openid)) return;
      seen.add(member.openid);
      hits.push(member);
    };

    for (const member of members.values()) {
      const id = member.openid.toLowerCase();
      if (id === lower || (idShaped && id.endsWith(lower))) {
        push(member);
        continue;
      }
      if (member.name && member.name.trim().toLowerCase() === lower) push(member);
    }

    return hits.length === 1 ? hits[0] : undefined;
  }

  /** 群太多时清掉整天没人说话的（lastSeen 只在这里用） */
  private pruneGroups(): void {
    if (this.groups.size <= this.maxGroups) return;
    const cutoff = Date.now() - GROUP_IDLE_MS;
    for (const [groupId, members] of this.groups) {
      let latest = 0;
      for (const member of members.values()) latest = Math.max(latest, member.lastSeen);
      if (latest < cutoff) this.groups.delete(groupId);
    }
  }
}

/** 群目录闲置多久算「可以忘掉」 */
const GROUP_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * 归一化模型给的 token。
 *
 * 容忍几种常见写法：完整 openid、尾号（大小写无所谓）、
 * 照抄整段 `[张三 (…030E)]`、`（030E）` 这种包了一层的。
 */
export function normalizeToken(raw: string): string {
  const text = raw.trim();
  // 带省略号就只取省略号后面那段（模型常直接抄消息里的显示形式）
  const ellipsis = text.lastIndexOf('…');
  if (ellipsis >= 0) {
    const tail = /^[0-9A-Za-z_-]{1,64}/.exec(text.slice(ellipsis + 1).trim());
    if (tail) return tail[0];
  }
  let token = text.replace(/^[@＠]/, '').trim();
  const wrapped = /^[(（\[【<'"「『]\s*(.+?)\s*[)）\]】>'"」』]$/u.exec(token);
  if (wrapped?.[1]) token = wrapped[1].trim();
  return token;
}

export interface AtMentionRewrite {
  /** 替换后的正文 */
  readonly text: string;
  /** 成功换成的 @ 个数 */
  readonly applied: number;
  /** 没换成的 token（供日志排查：解析失败 / 超上限） */
  readonly rejected: string[];
}

/** 把文本切成「普通段 / 代码段」交替的数组，索引为奇数的段是代码 */
function splitCode(text: string): string[] {
  return text.split(new RegExp(CODE_SPAN_SOURCE, 'g'));
}

/**
 * 把正文里的 `[[at:token]]` 换成官方 @ 标签（代码块内不动）。
 *
 * @param resolve token → openid；返回 undefined 表示解析失败
 * @param maxPerMessage 单条消息最多 @ 几个
 */
export function applyAtMentions(
  text: string,
  resolve: (token: string) => string | undefined,
  maxPerMessage: number = DEFAULT_MAX_AT_PER_MESSAGE,
): AtMentionRewrite {
  const rejected: string[] = [];
  let applied = 0;
  const rewriteSegment = (segment: string): string => segment.replace(
    new RegExp(TOKEN_SOURCE, 'gi'),
    (_match, rawToken: string) => {
      const token = normalizeToken(rawToken);
      if (!token) return REMOVED_MARKER;
      if (applied >= maxPerMessage) {
        rejected.push(token);
        return REMOVED_MARKER;
      }
      const openid = resolve(token);
      if (openid === undefined || !isSafeOpenid(openid)) {
        rejected.push(token);
        return REMOVED_MARKER;
      }
      applied += 1;
      return `<qqbot-at-user id="${openid}" />`;
    },
  );
  // 只收拾被删位置，代码段一个字符都不动
  const rewritten = splitCode(text)
    .map((segment, index) => (index % 2 === 1 ? segment : collapseRemovedMarkers(rewriteSegment(segment))))
    .join('');
  return { text: rewritten, applied, rejected };
}

/**
 * 群聊出站前置处理：按群把 `[[at:...]]` 换成官方标签。
 * 只负责正文；要不要 @、@ 谁由模型在正文里决定。
 */
export function rewriteGroupAtMentions(
  text: string,
  groupId: string,
  directory: GroupMemberDirectory,
  maxPerMessage: number = DEFAULT_MAX_AT_PER_MESSAGE,
): AtMentionRewrite {
  return applyAtMentions(text, token => directory.resolve(groupId, token)?.openid, maxPerMessage);
}

/**
 * 兜底清理：把没换成的 `[[at:...]]` 标记删掉（同样不碰代码块）。
 *
 * 用在不做 @ 解析的路径上：私聊正文、提问/审批等模型文本，避免内部语法漏给用户。
 */
export function sanitizeAtMentions(text: string): string {
  const strip = (segment: string): string => collapseRemovedMarkers(segment.replace(
    new RegExp(TOKEN_SOURCE, 'gi'),
    () => REMOVED_MARKER,
  ));
  return splitCode(text)
    .map((segment, index) => (index % 2 === 1 ? segment : strip(segment)))
    .join('');
}
