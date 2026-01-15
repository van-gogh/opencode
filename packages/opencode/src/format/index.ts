/**
 * Format 模块 - 代码格式化
 *
 * 本模块提供文件编辑后的自动格式化功能，支持多种格式化器：
 * - Prettier、Biome、ESLint 等 JavaScript/TypeScript 格式化器
 * - black、ruff 等 Python 格式化器
 * - gofmt、rustfmt 等语言专用格式化器
 *
 * 工作流程：
 * 1. 监听文件编辑事件
 * 2. 根据文件扩展名查找对应的格式化器
 * 3. 执行格式化命令
 *
 * @module format
 */

import { Bus } from "../bus" // 事件总线
import { File } from "../file" // 文件模块
import { Log } from "../util/log" // 日志工具
import path from "path" // 路径处理
import z from "zod" // 参数验证

import * as Formatter from "./formatter" // 格式化器定义
import { Config } from "../config/config" // 配置管理
import { mergeDeep } from "remeda" // 深度合并工具
import { Instance } from "../project/instance" // 项目实例

/**
 * Format 命名空间
 *
 * 提供格式化器管理和自动格式化功能
 */
export namespace Format {
  // 格式化模块的日志记录器
  const log = Log.create({ service: "format" })

  /**
   * 格式化器状态 Schema
   *
   * 用于报告每个格式化器的配置和可用性
   */
  export const Status = z
    .object({
      name: z.string(), // 格式化器名称
      extensions: z.string().array(), // 支持的文件扩展名
      enabled: z.boolean(), // 是否启用
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  /**
   * 格式化模块状态初始化
   *
   * 加载内置格式化器并应用用户配置
   */
  const state = Instance.state(async () => {
    // 记录每个格式化器的启用状态缓存
    const enabled: Record<string, boolean> = {}
    const cfg = await Config.get()

    const formatters: Record<string, Formatter.Info> = {}
    // 如果全局禁用格式化，直接返回
    if (cfg.formatter === false) {
      log.info("all formatters are disabled")
      return {
        enabled,
        formatters,
      }
    }

    // 加载内置格式化器
    for (const item of Object.values(Formatter)) {
      formatters[item.name] = item
    }
    // 应用用户配置，支持禁用或覆盖格式化器
    for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
      if (item.disabled) {
        delete formatters[name] // 用户禁用的格式化器
        continue
      }
      // 深度合并用户配置和内置配置
      const result: Formatter.Info = mergeDeep(formatters[name] ?? {}, {
        command: [],
        extensions: [],
        ...item,
      })

      if (result.command.length === 0) continue // 没有命令的格式化器无效

      // 自定义格式化器默认启用
      result.enabled = async () => true
      result.name = name
      formatters[name] = result
    }

    return {
      enabled,
      formatters,
    }
  })

  /**
   * 检查格式化器是否启用
   *
   * 结果会被缓存，避免重复检查
   *
   * @param item - 格式化器信息
   * @returns 是否启用
   */
  async function isEnabled(item: Formatter.Info) {
    const s = await state()
    let status = s.enabled[item.name]
    if (status === undefined) {
      // 首次检查，调用格式化器的 enabled 方法
      status = await item.enabled()
      s.enabled[item.name] = status // 缓存结果
    }
    return status
  }

  /**
   * 根据文件扩展名获取适用的格式化器
   *
   * @param ext - 文件扩展名（如 .ts, .py）
   * @returns 可用的格式化器列表
   */
  async function getFormatter(ext: string) {
    const formatters = await state().then((x) => x.formatters)
    const result = []
    for (const item of Object.values(formatters)) {
      log.info("checking", { name: item.name, ext })
      if (!item.extensions.includes(ext)) continue // 不支持的扩展名
      if (!(await isEnabled(item))) continue // 未启用
      log.info("enabled", { name: item.name, ext })
      result.push(item)
    }
    return result
  }

  /**
   * 获取所有格式化器的状态
   *
   * @returns 格式化器状态数组
   */
  export async function status() {
    const s = await state()
    const result: Status[] = []
    for (const formatter of Object.values(s.formatters)) {
      const enabled = await isEnabled(formatter)
      result.push({
        name: formatter.name,
        extensions: formatter.extensions,
        enabled,
      })
    }
    return result
  }

  /**
   * 初始化格式化模块
   *
   * 订阅文件编辑事件，在文件保存后自动运行格式化
   */
  export function init() {
    log.info("init")
    // 订阅文件编辑事件
    Bus.subscribe(File.Event.Edited, async (payload) => {
      const file = payload.properties.file
      log.info("formatting", { file })
      const ext = path.extname(file) // 获取文件扩展名

      // 遍历所有适用的格式化器
      for (const item of await getFormatter(ext)) {
        log.info("running", { command: item.command })
        try {
          // 启动格式化进程
          const proc = Bun.spawn({
            cmd: item.command.map((x) => x.replace("$FILE", file)), // 替换文件路径占位符
            cwd: Instance.directory, // 在项目目录执行
            env: { ...process.env, ...item.environment }, // 合并环境变量
            stdout: "ignore",
            stderr: "ignore",
          })
          const exit = await proc.exited
          if (exit !== 0)
            log.error("failed", {
              command: item.command,
              ...item.environment,
            })
        } catch (error) {
          log.error("failed to format file", {
            error,
            command: item.command,
            ...item.environment,
            file,
          })
        }
      }
    })
  }
}
