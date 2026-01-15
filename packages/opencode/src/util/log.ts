/**
 * Log 模块 - 日志系统
 *
 * 本模块提供统一的日志记录功能。
 *
 * 主要功能：
 * - 日志级别控制（DEBUG, INFO, WARN, ERROR）
 * - 标签化日志（为不同服务创建不同 logger）
 * - 文件日志（持久化到磁盘）
 * - 计时日志（测量操作耗时）
 * - 自动清理旧日志文件
 *
 * @module util/log
 */
import path from "path" // 路径处理
import fs from "fs/promises" // 文件系统
import { Global } from "../global" // 全局路径
import z from "zod" // Schema 验证

/**
 * Log 命名空间
 *
 * 提供日志记录的所有功能
 */
export namespace Log {
  /**
   * 日志级别定义
   *
   * - DEBUG: 调试信息，详细的内部状态
   * - INFO: 普通信息，正常操作日志
   * - WARN: 警告信息，可能的问题
   * - ERROR: 错误信息，需要关注的异常
   */
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  /**
   * 日志级别优先级映射
   *
   * 用于判断是否应该记录某个级别的日志
   */
  const levelPriority: Record<Level, number> = {
    DEBUG: 0, // 最低优先级
    INFO: 1,
    WARN: 2,
    ERROR: 3, // 最高优先级
  }

  // 当前日志级别，默认为 INFO
  let level: Level = "INFO"

  /**
   * 检查是否应该记录指定级别的日志
   *
   * @param input - 要检查的日志级别
   * @returns 是否应记录
   */
  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  /**
   * Logger 接口
   *
   * 定义日志记录器的所有方法
   */
  export type Logger = {
    /** 记录调试信息 */
    debug(message?: any, extra?: Record<string, any>): void
    /** 记录普通信息 */
    info(message?: any, extra?: Record<string, any>): void
    /** 记录错误信息 */
    error(message?: any, extra?: Record<string, any>): void
    /** 记录警告信息 */
    warn(message?: any, extra?: Record<string, any>): void
    /** 添加标签 */
    tag(key: string, value: string): Logger
    /** 克隆当前 logger */
    clone(): Logger
    /** 开始计时，返回可停止的对象 */
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  // Logger 缓存，按 service 名称缓存
  const loggers = new Map<string, Logger>()

  /** 默认 logger 实例 */
  export const Default = create({ service: "default" })

  /**
   * 日志初始化选项
   */
  export interface Options {
    print: boolean // 是否打印到控制台
    dev?: boolean // 是否为开发模式
    level?: Level // 日志级别
  }

  // 日志文件路径
  let logpath = ""

  /**
   * 获取日志文件路径
   *
   * @returns 日志文件路径
   */
  export function file() {
    return logpath
  }

  // 日志写入函数，默认写入 stderr
  let write = (msg: any) => {
    process.stderr.write(msg)
    return msg.length
  }

  /**
   * 初始化日志系统
   *
   * @param options - 初始化选项
   */
  export async function init(options: Options) {
    if (options.level) level = options.level
    cleanup(Global.Path.log)
    if (options.print) return
    logpath = path.join(
      Global.Path.log,
      options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    const logfile = Bun.file(logpath)
    await fs.truncate(logpath).catch(() => {})
    const writer = logfile.writer()
    write = async (msg: any) => {
      const num = writer.write(msg)
      writer.flush()
      return num
    }
  }

  /**
   * 清理旧日志文件
   *
   * 保留最近 10 个日志文件，删除更旧的
   *
   * @param dir - 日志目录
   */
  async function cleanup(dir: string) {
    const glob = new Bun.Glob("????-??-??T??????.log")
    const files = await Array.fromAsync(
      glob.scan({
        cwd: dir,
        absolute: true,
      }),
    )
    if (files.length <= 5) return

    const filesToDelete = files.slice(0, -10)
    await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
  }

  /**
   * 格式化错误信息
   *
   * 递归处理错误链（cause chain）
   *
   * @param error - 错误对象
   * @param depth - 递归深度（最多 10 层）
   * @returns 格式化的错误消息
   */
  function formatError(error: Error, depth = 0): string {
    const result = error.message
    return error.cause instanceof Error && depth < 10
      ? result + " Caused by: " + formatError(error.cause, depth + 1)
      : result
  }

  // 上次日志时间戳，用于计算时间差
  let last = Date.now()

  /**
   * 创建 Logger 实例
   *
   * 为指定服务创建日志记录器。
   * 相同 service 名称的 logger 会被缓存复用。
   *
   * @param tags - 日志标签，如 { service: "permission" }
   * @returns Logger 实例
   *
   * @example
   * const log = Log.create({ service: "session" })
   * log.info("session started", { sessionID: "abc" })
   */
  export function create(tags?: Record<string, any>) {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(message: any, extra?: Record<string, any>) {
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === "object") return prefix + JSON.stringify(value)
          return prefix + value
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
    }
    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldLog("DEBUG")) {
          write("DEBUG " + build(message, extra))
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          write("INFO  " + build(message, extra))
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          write("ERROR " + build(message, extra))
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          write("WARN  " + build(message, extra))
        }
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}
