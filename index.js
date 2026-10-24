/**
 * dsh-event-chime — Host half.
 *
 * 提示音完全跑在浏览器端：事件来自 ctx.uiSession.sessionStatus，
 * 音频来自 Web Audio 合成或 IndexedDB 里用户导入的文件。
 * Host 侧不需要任何服务、路由或持久化。
 */
export const name = 'dsh-event-chime';

export const inject = [];

export function apply() {}
