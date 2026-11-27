import { downloadMediaAttachments, isImageContentType, } from "../transport/attachment.js";
import { historyGroupKey } from "../features/group-history.js";
export function historyMediaProcessor(config, logger, store, download = downloadMediaAttachments) {
    return async (ctx, next) => {
        const msg = ctx.message;
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
        const task = (async () => {
            const files = await download(images, config.media, logger);
            if (files.length > 0) {
                store.attachMedia(groupId, msg.messageId, files.map(file => file.localPath));
                ctx.state.historyMedia = { attachments: images, files };
            }
        })().catch((err) => {
            // 下载失败不影响消息继续走（历史里就只有占位）
            logger.warn(`im-qqbot: history media download failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        // 登记在途任务：别的消息组包时可以等一下，路径就不会缺
        store.trackMedia(groupId, msg.messageId, task);
        await task;
        await next();
    };
}
//# sourceMappingURL=history-media.js.map