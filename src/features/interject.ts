/**
 * 群聊插话 —— 没人 @ 机器人时，按概率自己去接一句。
 *
 * 前提：QQ 官方机器人在群里默认只收到 @ 它的消息；要让机器人看到整段群聊，
 * 需要在手机 QQ 的机器人设置里把消息档位改成「获取群内全部消息」，
 * 之后群里的每条消息都会以 GROUP_MESSAGE_CREATE 推过来，这里才有得赌。
 *
 * 这里只管「要不要把这条当作在叫我」，真正的接不接还是交给 agent 自己判断。
 */

/** 群聊插话策略（可直接落在 config.groupInterject 里） */
export interface GroupInterjectConfig {
  /** 总开关，默认关 */
  enabled: boolean;
  /** 每条普通群消息触发插话的概率（0~1） */
  chance: number;
  /** 两次插话至少间隔（秒） */
  cooldownSec: number;
  /** 每小时最多插话次数（滚动 60 分钟） */
  maxPerHour: number;
  /** 静默时段 [开始, 结束) 本地小时；开始=结束表示不静默 */
  quietHours: number[];
  /** 窗口内群里至少要有这么多条消息才算「在聊」 */
  minRecentMessages: number;
  /** 判断「在聊」的回看窗口（秒） */
  activeWindowSec: number;
  /** 保底：连续多少条群消息没接话就强制插一次；0 = 关闭 */
  pityMessages: number;
}

export const DEFAULT_GROUP_INTERJECT: GroupInterjectConfig = {
  enabled: false,
  chance: 0.15,
  cooldownSec: 90,
  maxPerHour: 6,
  quietHours: [1, 8],
  minRecentMessages: 3,
  activeWindowSec: 300,
  pityMessages: 15,
};

export interface InterjectDecision {
  /** true = 把这条当作在叫机器人 */
  pass: boolean;
  /** 判断理由，日志/调试用 */
  reason: string;
}

/** 小时是否落在静默时段（支持跨零点，如 [22, 6]） */
export function inQuietHours(hour: number, quiet: number[] | undefined): boolean {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false;
  const [start, end] = quiet.map(Number) as [number, number];
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * 纯决策：给当前这条群消息判个「插不插话」。
 *
 * @param p.policy 策略
 * @param p.now 当前时间（毫秒）
 * @param p.hour 当前本地小时（0~23）
 * @param p.recentTimes 本群最近消息时间戳（毫秒，含当前这条）
 * @param p.interjectTimes 机器人自己最近插话时间戳（毫秒）
 * @param p.random 随机源，便于测试
 */
export function decideInterject(p: {
  policy: GroupInterjectConfig;
  now: number;
  hour: number;
  recentTimes?: number[];
  interjectTimes?: number[];
  /** 距离上一次插话（或启动）以来，群里又说了多少条 */
  sinceLastInterject?: number;
  random?: () => number;
}): InterjectDecision {
  const pol = p.policy ?? DEFAULT_GROUP_INTERJECT;
  const rand = p.random ?? Math.random;

  if (!pol.enabled) return { pass: false, reason: '插话关着' };
  if (inQuietHours(p.hour, pol.quietHours)) return { pass: false, reason: '静默时段' };

  const interjects = p.interjectTimes ?? [];
  const lastHour = interjects.filter((t) => p.now - t < HOUR_MS).length;
  if (lastHour >= Math.max(1, Number(pol.maxPerHour) || 1)) {
    return { pass: false, reason: `这小时插话够多了（${lastHour} 次）` };
  }

  // 保底：连续攒够 pityMessages 条没接话，就不再掷骰子，直接接一句
  const pity = Math.max(0, Math.floor(Number(pol.pityMessages) || 0));
  const sinceLast = Math.max(0, Math.floor(Number(p.sinceLastInterject) || 0));
  if (pity > 0 && sinceLast >= pity) {
    return { pass: true, reason: `保底（连续 ${sinceLast} 条没接话）` };
  }

  const window = Math.max(0, Number(pol.activeWindowSec) || 0) * 1000;
  const recent = (p.recentTimes ?? []).filter((t) => p.now - t < window).length;
  if (recent < Math.max(1, Number(pol.minRecentMessages) || 1)) {
    return { pass: false, reason: `群里没在聊（${recent} 条）` };
  }

  const last = interjects.length > 0 ? Math.max(...interjects) : 0;
  const cooldown = Math.max(0, Number(pol.cooldownSec) || 0) * 1000;
  if (last > 0 && p.now - last < cooldown) return { pass: false, reason: '插话冷却中' };

  const chance = Math.min(1, Math.max(0, Number(pol.chance) || 0));
  if (rand() >= chance) return { pass: false, reason: '这次不插话' };
  return { pass: true, reason: '这次接一句' };
}

/** 按群记住最近消息和自己插话的时间 */
export interface InterjectTracker {
  /** 记一条群消息（在群消息门控之前调用） */
  note(groupKey: string, at?: number): void;
  /** 判断这条要不要插话；通过时顺手记一次插话 */
  shouldInterject(groupKey: string, policy: GroupInterjectConfig): InterjectDecision;
  /** 清空（测试 / 重连用） */
  reset(): void;
}

/**
 * 建一个插话跟踪器。
 *
 * 只在内存里留最近一小时的记录；群多了会自然按需增长，
 * 超过上限的群按最早写入的顺序淘汰，避免长期跑着内存只涨不跌。
 */
export function createInterjectTracker(options: {
  now?: () => number;
  random?: () => number;
  maxGroups?: number;
} = {}): InterjectTracker {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const maxGroups = Math.max(1, options.maxGroups ?? 500);
  const messages = new Map<string, number[]>();
  const interjects = new Map<string, number[]>();
  /** 每个群自上次插话以来又说了多少条（保底用） */
  const pending = new Map<string, number>();

  /** 只留最近一小时，顺带把群数压在上限内 */
  function trim(map: Map<string, number[]>, key: string, list: number[], at: number): number[] {
    const kept = list.filter((t) => at - t < HOUR_MS);
    map.set(key, kept);
    if (map.size > maxGroups && map.has(key)) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined && oldest !== key) map.delete(oldest);
    }
    return kept;
  }

  return {
    note(groupKey, at = now()) {
      if (!groupKey) return;
      const list = messages.get(groupKey) ?? [];
      list.push(at);
      trim(messages, groupKey, list, at);
      pending.set(groupKey, (pending.get(groupKey) ?? 0) + 1);
      if (pending.size > maxGroups) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined && oldest !== groupKey) pending.delete(oldest);
      }
    },

    shouldInterject(groupKey, policy) {
      if (!groupKey) return { pass: false, reason: '没有群标识' };
      const at = now();
      const decision = decideInterject({
        policy,
        now: at,
        hour: new Date(at).getHours(),
        recentTimes: trim(messages, groupKey, messages.get(groupKey) ?? [], at),
        interjectTimes: trim(interjects, groupKey, interjects.get(groupKey) ?? [], at),
        sinceLastInterject: pending.get(groupKey) ?? 0,
        random,
      });
      if (decision.pass) {
        interjects.set(groupKey, [...(interjects.get(groupKey) ?? []), at]);
        pending.set(groupKey, 0);
      }
      return decision;
    },

    reset() {
      messages.clear();
      interjects.clear();
      pending.clear();
    },
  };
}
