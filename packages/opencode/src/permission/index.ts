/**
 * Permission 模块 - 权限管理系统
 *
 * 本模块实现了 AI 工具执行的权限控制。
 *
 * 主要功能：
 * - 权限请求（ask）：当工具需要执行敏感操作时请求用户确认
 * - 权限响应（respond）：处理用户的授权决定
 * - 模式匹配：支持通配符匹配的权限模式
 * - 永久授权：“始终允许”选项
 *
 * 权限响应类型：
 * - once: 仅这次允许
 * - always: 始终允许（本会话内）
 * - reject: 拒绝
 *
 * @module permission/index
 */

import { BusEvent } from "@/bus/bus-event" // 事件定义
import { Bus } from "@/bus" // 事件总线
import z from "zod" // Schema 验证
import { Log } from "../util/log" // 日志
import { Identifier } from "../id/id" // ID 生成
import { Plugin } from "../plugin" // 插件系统
import { Instance } from "../project/instance" // 项目实例
import { Wildcard } from "../util/wildcard" // 通配符匹配

/**
 * Permission 命名空间
 *
 * 提供权限管理的所有功能
 */
export namespace Permission {
  // 创建权限模块专用日志记录器
  const log = Log.create({ service: "permission" })

  /**
   * 将模式转换为键数组
   *
   * @param pattern - 权限模式
   * @param type - 权限类型
   * @returns 键数组
   */
  function toKeys(pattern: Info["pattern"], type: string): string[] {
    return pattern === undefined ? [type] : Array.isArray(pattern) ? pattern : [pattern]
  }

  /**
   * 检查键是否被已授权的模式覆盖
   *
   * @param keys - 要检查的键
   * @param approved - 已授权的模式
   * @returns 是否全部覆盖
   */
  function covered(keys: string[], approved: Record<string, boolean>): boolean {
    const pats = Object.keys(approved)
    return keys.every((k) => pats.some((p) => Wildcard.match(k, p)))
  }

  /**
   * 权限信息类型
   *
   * 包含权限请求的所有信息
   */
  export const Info = z
    .object({
      id: z.string(), // 权限 ID
      type: z.string(), // 权限类型（如 bash, edit, read）
      pattern: z.union([z.string(), z.array(z.string())]).optional(), // 匹配模式
      sessionID: z.string(), // 会话 ID
      messageID: z.string(), // 消息 ID
      callID: z.string().optional(), // 工具调用 ID
      message: z.string(), // 显示消息
      metadata: z.record(z.string(), z.any()), // 元数据
      time: z.object({
        created: z.number(), // 创建时间
      }),
    })
    .meta({
      ref: "Permission",
    })
  export type Info = z.infer<typeof Info>

  /** 权限相关事件 */
  export const Event = {
    /** 权限请求更新事件 */
    Updated: BusEvent.define("permission.updated", Info),
    /** 权限响应事件 */
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: z.string(), // 会话 ID
        permissionID: z.string(), // 权限 ID
        response: z.string(), // 响应类型
      }),
    ),
  }

  /**
   * 权限模块状态
   *
   * 使用 Instance.state 创建项目级别的单例状态
   */
  const state = Instance.state(
    () => {
      // 待处理的权限请求
      const pending: {
        [sessionID: string]: {
          [permissionID: string]: {
            info: Info
            resolve: () => void
            reject: (e: any) => void
          }
        }
      } = {}

      // 已授权的模式
      const approved: {
        [sessionID: string]: {
          [permissionID: string]: boolean
        }
      } = {}

      return {
        pending,
        approved,
      }
    },
    // 清理函数：拒绝所有待处理的权限
    async (state) => {
      for (const pending of Object.values(state.pending)) {
        for (const item of Object.values(pending)) {
          item.reject(new RejectedError(item.info.sessionID, item.info.id, item.info.callID, item.info.metadata))
        }
      }
    },
  )

  /** 获取待处理的权限 */
  export function pending() {
    return state().pending
  }

  /** 获取所有待处理权限列表 */
  export function list() {
    const { pending } = state()
    const result: Info[] = []
    for (const items of Object.values(pending)) {
      for (const item of Object.values(items)) {
        result.push(item.info)
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * 请求权限
   *
   * 当工具需要执行敏感操作时调用此函数。
   * 如果权限已被批准（always），则立即返回；
   * 否则创建一个待处理的权限请求，等待用户响应。
   *
   * @param input.type - 权限类型（如 bash, edit, read）
   * @param input.message - 显示给用户的消息
   * @param input.pattern - 匹配模式（可选）
   * @param input.callID - 工具调用 ID（可选）
   * @param input.sessionID - 会话 ID
   * @param input.messageID - 消息 ID
   * @param input.metadata - 附加元数据
   * @throws {RejectedError} 当用户拒绝权限或插件拒绝时
   */
  export async function ask(input: {
    type: Info["type"]
    message: Info["message"]
    pattern?: Info["pattern"]
    callID?: Info["callID"]
    sessionID: Info["sessionID"]
    messageID: Info["messageID"]
    metadata: Info["metadata"]
  }) {
    const { pending, approved } = state()
    log.info("asking", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      toolCallID: input.callID,
      pattern: input.pattern,
    })
    const approvedForSession = approved[input.sessionID] || {}
    const keys = toKeys(input.pattern, input.type)
    if (covered(keys, approvedForSession)) return
    const info: Info = {
      id: Identifier.ascending("permission"),
      type: input.type,
      pattern: input.pattern,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      message: input.message,
      metadata: input.metadata,
      time: {
        created: Date.now(),
      },
    }

    switch (
      await Plugin.trigger("permission.ask", info, {
        status: "ask",
      }).then((x) => x.status)
    ) {
      case "deny":
        throw new RejectedError(info.sessionID, info.id, info.callID, info.metadata)
      case "allow":
        return
    }

    pending[input.sessionID] = pending[input.sessionID] || {}
    return new Promise<void>((resolve, reject) => {
      pending[input.sessionID][info.id] = {
        info,
        resolve,
        reject,
      }
      Bus.publish(Event.Updated, info)
    })
  }

  /**
   * 权限响应类型
   *
   * - once: 仅这次允许
   * - always: 始终允许（本会话内记住）
   * - reject: 拒绝此操作
   */
  export const Response = z.enum(["once", "always", "reject"])
  export type Response = z.infer<typeof Response>

  /**
   * 响应权限请求
   *
   * 处理用户对权限请求的响应。
   * - once: 解决当前请求，允许执行
   * - always: 解决当前请求，并记住该模式的授权
   * - reject: 拒绝请求，抛出 RejectedError
   *
   * 当响应为 "always" 时，会自动批准所有匹配相同模式的待处理请求。
   *
   * @param input.sessionID - 会话 ID
   * @param input.permissionID - 权限请求 ID
   * @param input.response - 用户响应（once/always/reject）
   */
  export function respond(input: { sessionID: Info["sessionID"]; permissionID: Info["id"]; response: Response }) {
    log.info("response", input)
    const { pending, approved } = state()
    const match = pending[input.sessionID]?.[input.permissionID]
    if (!match) return
    delete pending[input.sessionID][input.permissionID]
    Bus.publish(Event.Replied, {
      sessionID: input.sessionID,
      permissionID: input.permissionID,
      response: input.response,
    })
    if (input.response === "reject") {
      match.reject(new RejectedError(input.sessionID, input.permissionID, match.info.callID, match.info.metadata))
      return
    }
    match.resolve()
    if (input.response === "always") {
      approved[input.sessionID] = approved[input.sessionID] || {}
      const approveKeys = toKeys(match.info.pattern, match.info.type)
      for (const k of approveKeys) {
        approved[input.sessionID][k] = true
      }
      const items = pending[input.sessionID]
      if (!items) return
      for (const item of Object.values(items)) {
        const itemKeys = toKeys(item.info.pattern, item.info.type)
        if (covered(itemKeys, approved[input.sessionID])) {
          respond({
            sessionID: item.info.sessionID,
            permissionID: item.info.id,
            response: input.response,
          })
        }
      }
    }
  }

  /**
   * 权限拒绝错误
   *
   * 当用户拒绝权限请求时抛出此错误。
   * 包含完整的上下文信息，用于错误处理和日志记录。
   */
  export class RejectedError extends Error {
    /**
     * @param sessionID - 会话 ID
     * @param permissionID - 权限 ID
     * @param toolCallID - 工具调用 ID（可选）
     * @param metadata - 附加元数据（可选）
     * @param reason - 拒绝原因（可选）
     */
    constructor(
      public readonly sessionID: string,
      public readonly permissionID: string,
      public readonly toolCallID?: string,
      public readonly metadata?: Record<string, any>,
      public readonly reason?: string,
    ) {
      super(
        reason !== undefined
          ? reason
          : `The user rejected permission to use this specific tool call. You may try again with different parameters.`,
      )
    }
  }
}
