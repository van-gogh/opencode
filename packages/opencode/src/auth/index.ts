/**
 * Auth 模块 - 认证管理
 *
 * 本模块提供 AI 提供商的认证信息管理功能，支持以下认证方式：
 * - OAuth: 通过 OAuth 流程获取的访问/刷新令牌
 * - API Key: 直接使用 API 密钥
 * - WellKnown: 通过已知端点发现的认证
 *
 * 认证信息存储在用户数据目录的 auth.json 文件中，
 * 文件权限设为 0o600 保证安全性。
 *
 * @module auth
 */

import path from "path" // 路径处理
import { Global } from "../global" // 全局路径配置
import fs from "fs/promises" // 文件系统操作
import z from "zod" // 参数验证

/**
 * Auth 命名空间
 *
 * 提供认证信息的增删改查接口
 */
export namespace Auth {
  /**
   * OAuth 认证类型 Schema
   *
   * 用于通过 OAuth 流程认证的提供商，如 GitHub、Google 等
   */
  export const Oauth = z
    .object({
      type: z.literal("oauth"), // 认证类型标识
      refresh: z.string(), // 刷新令牌，用于获取新的访问令牌
      access: z.string(), // 访问令牌，用于 API 请求
      expires: z.number(), // 访问令牌过期时间戳
      enterpriseUrl: z.string().optional(), // 企业版 URL（可选）
    })
    .meta({ ref: "OAuth" })

  /**
   * API Key 认证类型 Schema
   *
   * 用于直接使用 API 密钥认证的提供商
   */
  export const Api = z
    .object({
      type: z.literal("api"), // 认证类型标识
      key: z.string(), // API 密钥
    })
    .meta({ ref: "ApiAuth" })

  /**
   * WellKnown 认证类型 Schema
   *
   * 用于通过 .well-known 端点发现的认证方式
   */
  export const WellKnown = z
    .object({
      type: z.literal("wellknown"), // 认证类型标识
      key: z.string(), // 密钥标识
      token: z.string(), // 认证令牌
    })
    .meta({ ref: "WellKnownAuth" })

  /**
   * 认证信息联合类型
   *
   * 通过 type 字段区分不同的认证方式
   */
  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  // 认证信息存储文件路径
  const filepath = path.join(Global.Path.data, "auth.json")

  /**
   * 获取指定提供商的认证信息
   *
   * @param providerID - 提供商 ID
   * @returns 认证信息，不存在返回 undefined
   */
  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  /**
   * 获取所有提供商的认证信息
   *
   * 读取并解析 auth.json 文件，过滤无效的认证条目
   *
   * @returns 提供商 ID 到认证信息的映射
   */
  export async function all(): Promise<Record<string, Info>> {
    const file = Bun.file(filepath)
    // 读取文件，失败返回空对象
    const data = await file.json().catch(() => ({}) as Record<string, unknown>)
    // 遍历并验证每个认证条目
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc // 跳过无效条目
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  /**
   * 设置提供商的认证信息
   *
   * @param key - 提供商 ID
   * @param info - 认证信息
   */
  export async function set(key: string, info: Info) {
    const file = Bun.file(filepath)
    const data = await all()
    // 合并新的认证信息并写入文件
    await Bun.write(file, JSON.stringify({ ...data, [key]: info }, null, 2))
    // 设置文件权限为仅所有者可读写，保护敏感信息
    await fs.chmod(file.name!, 0o600)
  }

  /**
   * 删除提供商的认证信息
   *
   * @param key - 提供商 ID
   */
  export async function remove(key: string) {
    const file = Bun.file(filepath)
    const data = await all()
    delete data[key] // 删除指定提供商
    await Bun.write(file, JSON.stringify(data, null, 2))
    // 保持文件权限设置
    await fs.chmod(file.name!, 0o600)
  }
}
