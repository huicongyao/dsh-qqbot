/**
 * openid 展示工具（纯函数，客户端 bundle 会内联，勿引入 node 依赖）。
 *
 * 官方只给 AppID 维度的匿名 openid（32 位 hex：群成员一套、私聊一套），
 * 对模型只暴露尾号：既能区分群友，又不把完整身份写进 prompt。
 */
/** openid 尾号展示（保留后 4 位，其余打码）。 */
export function maskOpenid(openid) {
    return `…${openid.trim().slice(-4)}`;
}
/** openid / 尾号是否是可安全拼进标签的字符集（平台侧下发，仍做一次白名单校验）。 */
export function isSafeOpenid(value) {
    return /^[0-9A-Za-z_-]{1,64}$/.test(value);
}
//# sourceMappingURL=openid.js.map