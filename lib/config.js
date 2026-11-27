/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_GROUP_INTERJECT } from "./features/interject.js";
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema = Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式（默认开放）'),
    commandMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('斜杠命令模式（所有人／白名单／关闭）'),
    c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式（默认开放：群自带进群门槛 + @bot 触发）'),
    groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单（群 OpenID）'),
});
/** 群聊插话子 Schema（独立导出：config 路由的服务端校验复用） */
export const GroupInterjectSchema = Schema.object({
    enabled: Schema.boolean().default(DEFAULT_GROUP_INTERJECT.enabled)
        .description('没人 @ 时也按概率自己接一句（需要机器人消息档位为「获取群内全部消息」）'),
    chance: Schema.number().min(0).max(1).default(DEFAULT_GROUP_INTERJECT.chance)
        .description('每条普通群消息触发插话的概率（0~1）'),
    cooldownSec: Schema.number().min(0).default(DEFAULT_GROUP_INTERJECT.cooldownSec)
        .description('两次插话最少间隔（秒）'),
    maxPerHour: Schema.number().min(1).default(DEFAULT_GROUP_INTERJECT.maxPerHour)
        .description('每小时最多插话次数（滚动 60 分钟）'),
    quietHours: Schema.array(Schema.number()).default([...DEFAULT_GROUP_INTERJECT.quietHours])
        .description('静默时段 [开始, 结束) 本地小时，两者相等表示不静默'),
    minRecentMessages: Schema.number().min(1).default(DEFAULT_GROUP_INTERJECT.minRecentMessages)
        .description('回看窗口内至少多少条群消息才算「在聊」'),
    activeWindowSec: Schema.number().min(30).default(DEFAULT_GROUP_INTERJECT.activeWindowSec)
        .description('判断「在聊」的回看窗口（秒）'),
    pityMessages: Schema.number().min(0).default(DEFAULT_GROUP_INTERJECT.pityMessages)
        .description('保底：连续多少条群消息没接话就强制插一次（0 = 关闭）'),
});
export const ConfigSchema = Schema.object({
    appId: Schema.string().default('').description('QQ 机器人 AppID'),
    appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
    provider: Schema.string().description('LLM provider name'),
    model: Schema.string().description('Model name'),
    preset: Schema.string().description('Agent preset id'),
    cwd: Schema.string().description('Agent working directory (default ~/.dsh-qqbot/workspace)'),
    requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
    groupInterject: GroupInterjectSchema.default({ ...DEFAULT_GROUP_INTERJECT }).description('群聊插话策略'),
    groupPrompt: Schema.string().description('群聊额外system prompt'),
    directPrompt: Schema.string().description('私聊额外system prompt'),
    textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
    streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
    sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)，<=0 不回收'),
    maxQueue: Schema.number().default(20).description('并发队列最大长度'),
    processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
    askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
    historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
    historyMaxAgeSec: Schema.number().default(30 * 60).description('群历史时间窗（秒），更早的消息不再带进 prompt'),
    historyMedia: Schema.object({
        enabled: Schema.boolean().default(true).description('给只进群历史的图片/表情也下载本地路径（群里每张图都会落盘）'),
    }).default({ enabled: true }).description('历史媒体下载'),
    access: AccessControlSchema.default({
        c2cMode: 'open',
        c2cAllow: [],
        groupMode: 'open',
        groupAllow: [],
    }).description('访问控制'),
    showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
    debug: Schema.boolean().default(false),
    media: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
        maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
        ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
    }).default({
        enabled: true,
        maxMB: 200,
        ttlHours: 24,
    }).description('富媒体理解配置'),
    vision: Schema.object({
        enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
        provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
        model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
        defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
        maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
        maxTokens: Schema.number().default(1024).description('输出 token 上限'),
        timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
    }).default({
        enabled: false,
        provider: '',
        model: '',
        defaultPrompt: 'Describe this image in detail.',
        maxBytes: 10 * 1024 * 1024,
        maxTokens: 1024,
        timeoutMs: 120000,
    }).description('视觉理解配置'),
    sendFile: Schema.object({
        restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
        extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
        sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
        maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
    }).default({
        restrictPaths: true,
        extraRoots: [],
        sendPresentedFiles: true,
        maxFiles: 4,
    }).description('附件发送配置'),
    proactiveDelivery: Schema.object({
        externalTurns: Schema.union(['off', 'c2c', 'all']).default('c2c')
            .description('非 QQ 输入（如桌面续聊）的回合是否推送到 QQ：off=不推送，c2c=仅私聊，all=私聊和群聊'),
    }).default({
        externalTurns: 'c2c',
    }).description('主动推送策略（定时任务等服务回合始终推送）'),
});
//# sourceMappingURL=config.js.map