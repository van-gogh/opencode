/**
 * Bus 模块 - 事件总线系统
 *
 * 本模块实现了 OpenCode 内部的事件发布/订阅系统，
 * 用于模块之间的解耦通信。
 *
 * 主要功能：
 * - 事件发布：向所有订阅者广播事件
 * - 事件订阅：订阅特定类型或所有事件
 * - 一次性订阅：订阅后自动取消
 *
 * 使用场景：
 * - 会话创建/更新/删除事件
 * - 消息更新事件
 * - 工具执行事件
 * - 服务器状态事件
 *
 * @module bus
 */

import z from "zod" // 参数验证
import { Log } from "../util/log" // 日志工具
import { Instance } from "../project/instance" // 项目实例
import { BusEvent } from "./bus-event" // 事件定义工具
import { GlobalBus } from "./global" // 全局事件总线

/**
 * Bus 命名空间
 *
 * 提供项目级别的事件总线功能
 */
export namespace Bus {
  // 创建 Bus 模块专用的日志记录器
  const log = Log.create({ service: "bus" })

  /**
   * 订阅函数类型
   * 接收事件对象作为参数
   */
  type Subscription = (event: any) => void

  /**
   * 实例销毁事件
   * 当项目实例被销毁时触发
   */
  export const InstanceDisposed = BusEvent.define(
    "server.instance.disposed",
    z.object({
      directory: z.string(), // 被销毁实例的目录
    }),
  )

  /**
   * 事件总线状态
   *
   * 使用 Instance.state 创建项目级别的状态，
   * 包含所有事件订阅者的映射表
   */
  const state = Instance.state(
    () => {
      // 订阅者映射表：事件类型 -> 订阅函数数组
      const subscriptions = new Map<any, Subscription[]>()

      return {
        subscriptions,
      }
    },
    // 实例销毁时的清理函数
    async (entry) => {
      const wildcard = entry.subscriptions.get("*")
      if (!wildcard) return
      // 通知所有通配符订阅者
      const event = {
        type: InstanceDisposed.type,
        properties: {
          directory: Instance.directory,
        },
      }
      for (const sub of [...wildcard]) {
        sub(event)
      }
    },
  )

  /**
   * 发布事件
   *
   * 将事件发送给所有匹配的订阅者，包括：
   * - 特定事件类型的订阅者
   * - 通配符 "*" 订阅者（订阅所有事件）
   * - 全局事件总线
   *
   * @param def - 事件定义
   * @param properties - 事件属性
   * @returns Promise，所有订阅者处理完成后解析
   */
  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload = {
      type: def.type,
      properties,
    }
    log.info("publishing", {
      type: def.type,
    })
    const pending = []
    // 向特定类型和通配符订阅者发送事件
    for (const key of [def.type, "*"]) {
      const match = state().subscriptions.get(key)
      for (const sub of match ?? []) {
        pending.push(sub(payload))
      }
    }
    // 同时发送到全局事件总线
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload,
    })
    return Promise.all(pending)
  }

  /**
   * 订阅特定类型的事件
   *
   * @param def - 事件定义
   * @param callback - 事件处理回调函数
   * @returns 取消订阅的函数
   */
  export function subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]> }) => void,
  ) {
    return raw(def.type, callback)
  }

  /**
   * 一次性订阅
   *
   * 订阅事件，当回调返回 "done" 时自动取消订阅
   *
   * @param def - 事件定义
   * @param callback - 事件处理回调，返回 "done" 表示完成
   */
  export function once<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => "done" | undefined,
  ) {
    const unsub = subscribe(def, (event) => {
      if (callback(event)) unsub() // 返回 "done" 时取消订阅
    })
  }

  /**
   * 订阅所有事件
   *
   * 使用通配符 "*" 订阅所有事件
   *
   * @param callback - 事件处理回调函数
   * @returns 取消订阅的函数
   */
  export function subscribeAll(callback: (event: any) => void) {
    return raw("*", callback)
  }

  /**
   * 原始订阅函数（内部使用）
   *
   * 注册订阅并返回取消函数
   *
   * @param type - 事件类型或 "*" 通配符
   * @param callback - 事件处理回调函数
   * @returns 取消订阅的函数
   */
  function raw(type: string, callback: (event: any) => void) {
    log.info("subscribing", { type })
    const subscriptions = state().subscriptions
    // 获取或创建订阅者列表
    let match = subscriptions.get(type) ?? []
    match.push(callback)
    subscriptions.set(type, match)

    // 返回取消订阅函数
    return () => {
      log.info("unsubscribing", { type })
      const match = subscriptions.get(type)
      if (!match) return
      const index = match.indexOf(callback)
      if (index === -1) return
      match.splice(index, 1)
    }
  }
}
