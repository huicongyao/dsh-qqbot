/**
 * 历史媒体中间件 — 给「没被放行、只会进群历史」的消息也下载图片
 *
 * 默认的 attachmentProcessor 在 @ 门控之后，只有真正触发 agent 的消息才下载；
 * 被门控挡掉的图片/表情在历史里只有占位、没有路径，模型就看不到。
 * 这个中间件放在门控之前，只挑图片类附件下载，并把本地路径挂到历史条目上。
 *
 * 代价：群里每张图都会落一次盘（受 media.maxMB / media.ttlHours 约束）。
 * 可以用 config.historyMedia.enabled 关掉。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, RawAttachment } from '../types.ts';
import {
  downloadMediaAttachments,
  isImageContentType,
  type DownloadedFile,
} from '../transport/attachment.ts';
import { historyGroupKey, type GroupHistoryStore } from '../features/group-history.ts';

/** 下载器签名（测试可注入） */
export type HistoryMediaDownloader = (
  attachments: RawAttachment[] | undefined,
  media: ImQQBotConfig['media'],
  logger: Logger,
) => Promise<DownloadedFile[]>;

/** 消息上已预下载的内容，供后面的 attachmentProcessor 复用，避免同一张图下两次 */
export interface PreDownloadedMedia {
  attachments: RawAttachment[];
  files: DownloadedFile[];
}

export function historyMediaProcessor(
  config: ImQQBotConfig,
  logger: Logger,
  store: GroupHistoryStore,
  download: HistoryMediaDownloader = downloadMediaAttachments,
) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message as {
      kind?: string;
      groupOpenid?: string;
      messageId?: string;
      attachments?: RawAttachment[];
    };
    if (!config.historyMedia.enabled || msg.kind !== 'group' || !msg.groupOpenid || !msg.messageId) {
      await next();
      return;
    }

    const images = (msg.attachments ?? []).filter(att => isImageContentType(att.content_type) && att.url);
    if (images.length === 0) {
      await next();
      return;
    }

    const groupId = historyGroupKey(config.appId, msg.groupOpenid);
    const task = (async (): Promise<void> => {
      const files = await download(images, config.media, logger);
      if (files.length > 0) {
        store.attachMedia(groupId, msg.messageId as string, files.map(file => file.localPath));
        (ctx.state as Record<string, unknown>).historyMedia = { attachments: images, files } satisfies PreDownloadedMedia;
      }
    })().catch((err: unknown) => {
      // 下载失败不影响消息继续走（历史里就只有占位）
      logger.warn(`im-qqbot: history media download failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // 登记在途任务：别的消息组包时可以等一下，路径就不会缺
    store.trackMedia(groupId, msg.messageId, task);
    await task;

    await next();
  };
}
