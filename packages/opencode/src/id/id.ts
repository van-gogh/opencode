/**
 * Identifier 模块 - ID 生成器
 *
 * 本模块提供全局唯一标识符生成功能，支持多种实体类型。
 * 生成的 ID 具有以下特点：
 * - 时间有序：包含时间戳，支持按时间排序
 * - 单调递增/递减：同一毫秒内的 ID 保持有序
 * - 类型前缀：不同实体有不同前缀，便于识别
 * - 全局唯一：组合时间戳和随机数确保唯一性
 *
 * ID 格式：{prefix}_{timestamp_hex}{random_base62}
 * 例如：ses_01234567890abcdefABCDEFGH
 *
 * @module id
 */

import z from "zod" // 参数验证
import { randomBytes } from "crypto" // 随机数生成

/**
 * Identifier 命名空间
 *
 * 提供各种实体的 ID 生成和验证接口
 */
export namespace Identifier {
  /**
   * 实体类型到 ID 前缀的映射
   *
   * 每种实体类型有固定的3字符前缀
   */
  const prefixes = {
    session: "ses", // 会话
    message: "msg", // 消息
    permission: "per", // 权限
    question: "que", // 问题
    user: "usr", // 用户
    part: "prt", // 消息部分
    pty: "pty", // 伪终端
    tool: "tool", // 工具
  } as const

  /**
   * 创建 ID 验证 Schema
   *
   * @param prefix - 实体类型前缀
   * @returns Zod schema，验证字符串是否以指定前缀开头
   */
  export function schema(prefix: keyof typeof prefixes) {
    return z.string().startsWith(prefixes[prefix])
  }

  // ID 总长度（不含前缀和下划线）
  const LENGTH = 26

  // 单调 ID 生成状态
  let lastTimestamp = 0 // 上次生成时间
  let counter = 0 // 同一毫秒内的计数器

  /**
   * 生成升序 ID
   *
   * 按时间顺序排列，适合需要按创建时间排序的场景
   *
   * @param prefix - 实体类型前缀
   * @param given - 已有 ID（可选），如果提供则验证并返回
   * @returns ID 字符串
   */
  export function ascending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, false, given)
  }

  /**
   * 生成降序 ID
   *
   * 按时间逆序排列，适合需要最新数据在前的场景
   *
   * @param prefix - 实体类型前缀
   * @param given - 已有 ID（可选），如果提供则验证并返回
   * @returns ID 字符串
   */
  export function descending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, true, given)
  }

  /**
   * ID 生成内部实现
   *
   * @param prefix - 实体类型前缀
   * @param descending - 是否降序
   * @param given - 已有 ID（可选）
   * @returns ID 字符串
   */
  function generateID(prefix: keyof typeof prefixes, descending: boolean, given?: string): string {
    if (!given) {
      return create(prefix, descending)
    }

    // 验证已有 ID 的前缀是否匹配
    if (!given.startsWith(prefixes[prefix])) {
      throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
    }
    return given
  }

  /**
   * 生成 Base62 随机字符串
   *
   * 使用 0-9, A-Z, a-z 共 62 个字符
   *
   * @param length - 字符串长度
   * @returns Base62 编码的随机字符串
   */
  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  /**
   * 创建新 ID
   *
   * ID 结构：
   * 1. 前缀：3-4 字符，表示实体类型
   * 2. 下划线分隔符
   * 3. 时间戳：12 个十六进制字符（6字节）
   * 4. 随机部分：14 个 Base62 字符
   *
   * @param prefix - 实体类型前缀
   * @param descending - 是否降序（取反时间戳）
   * @param timestamp - 自定义时间戳（可选）
   * @returns 新生成的 ID
   */
  export function create(prefix: keyof typeof prefixes, descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    // 处理同一毫秒内的多次调用
    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0 // 新的毫秒，重置计数器
    }
    counter++ // 递增计数器确保单调性

    // 组合时间戳和计数器，确保唯一性和有序性
    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    // 如果是降序，对时间戳取反
    now = descending ? ~now : now

    // 将时间戳转换为 6 字节
    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    // 组合前缀 + 时间戳十六进制 + 随机部分
    return prefixes[prefix] + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
  }

  /**
   * 从升序 ID 中提取时间戳
   *
   * 注意：不适用于降序 ID（时间戳被取反）
   *
   * @param id - ID 字符串
   * @returns Unix 时间戳（毫秒）
   */
  export function timestamp(id: string): number {
    const prefix = id.split("_")[0] // 提取前缀
    // 提取时间戳部分（12个十六进制字符）
    const hex = id.slice(prefix.length + 1, prefix.length + 13)
    const encoded = BigInt("0x" + hex)
    // 移除计数器部分，还原时间戳
    return Number(encoded / BigInt(0x1000))
  }
}
