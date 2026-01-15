/**
 * Share 模块 - 会话分享
 *
 * 本模块提供会话分享功能，允许用户将会话分享给他人。
 *
 * 主要功能：
 * - 创建分享链接
 * - 同步会话数据到服务器
 * - 删除分享
 *
 * 同步内容包括：
 * - 会话信息
 * - 消息内容
 * - 消息部分（Part）
 *
 * @module share/share
 */
import { Bus } from "../bus" // 事件总线
import { Installation } from "../installation" // 安装信息
import { Session } from "../session" // 会话模块
import { MessageV2 } from "../session/message-v2" // 消息模块
import { Log } from "../util/log" // 日志

/**
 * Share 命名空间
 *
 * 提供会话分享功能
 */
export namespace Share {
  // 创建分享模块日志记录器
  const log = Log.create({ service: "share" })

  // 同步队列，确保顺序执行
  let queue: Promise<void> = Promise.resolve()
  // 待同步的内容
  const pending = new Map<string, any>()

  /**
   * 同步内容到分享服务器
   *
   * 如果会话已分享，将内容同步到服务器
   *
   * @param key - 内容键（如 "session/info/xxx"）
   * @param content - 要同步的内容
   */
  export async function sync(key: string, content: any) {
    const [root, ...splits] = key.split("/")
    if (root !== "session") return
    const [sub, sessionID] = splits
    if (sub === "share") return
    const share = await Session.getShare(sessionID).catch(() => {})
    if (!share) return
    const { secret } = share
    pending.set(key, content)
    queue = queue
      .then(async () => {
        const content = pending.get(key)
        if (content === undefined) return
        pending.delete(key)

        return fetch(`${URL}/share_sync`, {
          method: "POST",
          body: JSON.stringify({
            sessionID: sessionID,
            secret,
            key: key,
            content,
          }),
        })
      })
      .then((x) => {
        if (x) {
          log.info("synced", {
            key: key,
            status: x.status,
          })
        }
      })
  }

  /**
   * 初始化分享模块
   *
   * 订阅会话和消息事件，自动同步到服务器
   */
  export function init() {
    Bus.subscribe(Session.Event.Updated, async (evt) => {
      await sync("session/info/" + evt.properties.info.id, evt.properties.info)
    })
    Bus.subscribe(MessageV2.Event.Updated, async (evt) => {
      await sync("session/message/" + evt.properties.info.sessionID + "/" + evt.properties.info.id, evt.properties.info)
    })
    Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      await sync(
        "session/part/" +
          evt.properties.part.sessionID +
          "/" +
          evt.properties.part.messageID +
          "/" +
          evt.properties.part.id,
        evt.properties.part,
      )
    })
  }

  /** API 服务器地址 */
  export const URL =
    process.env["OPENCODE_API"] ??
    (Installation.isPreview() || Installation.isLocal() ? "https://api.dev.opencode.ai" : "https://api.opencode.ai")

  /**
   * 创建分享链接
   *
   * @param sessionID - 会话 ID
   * @returns 分享 URL 和密钥
   */
  export async function create(sessionID: string) {
    return fetch(`${URL}/share_create`, {
      method: "POST",
      body: JSON.stringify({ sessionID: sessionID }),
    })
      .then((x) => x.json())
      .then((x) => x as { url: string; secret: string })
  }

  /**
   * 删除分享
   *
   * @param sessionID - 会话 ID
   * @param secret - 分享密钥
   * @returns 删除结果
   */
  export async function remove(sessionID: string, secret: string) {
    return fetch(`${URL}/share_delete`, {
      method: "POST",
      body: JSON.stringify({ sessionID, secret }),
    }).then((x) => x.json())
  }
}
