/**
 * BusEvent 模块 - 事件定义工具
 *
 * 本模块提供类型安全的事件定义功能，用于定义事件总线中使用的事件类型。
 * 
 * 主要功能：
 * - define(): 定义新事件类型，包含事件名称和数据结构
 * - payloads(): 生成所有事件的联合类型 Schema
 *
 * 每个事件定义包含：
 * - type: 事件类型标识符（如 "session.created"）
 * - properties: 事件负载的 Zod Schema
 *
 * @module bus/bus-event
 */

import z from "zod" // 参数验证
import type { ZodType } from "zod" // Zod 类型
import { Log } from "../util/log" // 日志工具

/**
 * BusEvent 命名空间
 *
 * 提供事件定义和类型生成接口
 */
export namespace BusEvent {
  // 事件模块的日志记录器
  const log = Log.create({ service: "event" })

  /** 事件定义类型 */
  export type Definition = ReturnType<typeof define>

  // 事件注册表：事件类型 -> 事件定义
  const registry = new Map<string, Definition>()

  /**
   * 定义新事件类型
   *
   * @param type - 事件类型标识符，如 "session.created"
   * @param properties - 事件负载的 Zod Schema
   * @returns 事件定义对象，可用于发布和订阅
   */
  export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
    const result = {
      type, // 事件类型
      properties, // 事件数据结构
    }
    registry.set(type, result) // 注册事件
    return result
  }

  /**
   * 生成所有已注册事件的联合类型 Schema
   *
   * 用于 API 类型生成和运行时验证
   *
   * @returns 包含所有事件类型的区分联合 Schema
   */
  export function payloads() {
    return z
      .discriminatedUnion(
        "type", // 使用 type 字段区分不同事件
        registry
          .entries()
          .map(([type, def]) => {
            // 为每个事件创建 Schema
            return z
              .object({
                type: z.literal(type), // 事件类型字面量
                properties: def.properties, // 事件数据
              })
              .meta({
                ref: "Event" + "." + def.type, // API 文档引用名
              })
          })
          .toArray() as any,
      )
      .meta({
        ref: "Event", // 联合类型的引用名
      })
  }
}
