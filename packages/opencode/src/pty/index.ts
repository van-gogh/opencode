/**
 * Pty 模块 - 伪终端管理
 *
 * 本模块提供伪终端（PTY）的创建和管理功能，用于实现 Web 终端界面。
 * 基于 bun-pty 实现，支持完整的终端交互。
 *
 * 主要功能：
 * - create(): 创建新的终端会话
 * - remove(): 关闭终端会话
 * - write(): 向终端写入数据
 * - resize(): 调整终端大小
 * - connect(): 连接 WebSocket 到终端
 *
 * 特点：
 * - 支持多个 WebSocket 客户端连接
 * - 内存缓冲区限制（最大 2MB）
 * - 自动清理已退出的会话
 *
 * @module pty
 */

import { BusEvent } from "@/bus/bus-event" // 事件定义
import { Bus } from "@/bus" // 事件总线
import { type IPty } from "bun-pty" // PTY 类型
import z from "zod" // 参数验证
import { Identifier } from "../id/id" // ID 生成
import { Log } from "../util/log" // 日志工具
import type { WSContext } from "hono/ws" // WebSocket 上下文
import { Instance } from "../project/instance" // 项目实例
import { lazy } from "@opencode-ai/util/lazy" // 延迟加载
import { Shell } from "@/shell/shell" // Shell 配置

/**
 * Pty 命名空间
 *
 * 提供伪终端的创建、管理和交互接口
 */
export namespace Pty {
  // PTY 模块的日志记录器
  const log = Log.create({ service: "pty" })

  // 缓冲区限制常量
  const BUFFER_LIMIT = 1024 * 1024 * 2 // 最大缓冲区 2MB
  const BUFFER_CHUNK = 64 * 1024 // 每次发送的块大小 64KB

  /**
   * 延迟加载 bun-pty 模块
   * 避免在不需要时加载原生模块
   */
  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  /**
   * 终端会话信息 Schema
   */
  export const Info = z
    .object({
      id: Identifier.schema("pty"), // 会话 ID
      title: z.string(), // 终端标题
      command: z.string(), // 执行的命令
      args: z.array(z.string()), // 命令参数
      cwd: z.string(), // 工作目录
      status: z.enum(["running", "exited"]), // 运行状态
      pid: z.number(), // 进程 ID
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  /**
   * 创建终端的输入参数 Schema
   */
  export const CreateInput = z.object({
    command: z.string().optional(), // 命令（默认使用首选 Shell）
    args: z.array(z.string()).optional(), // 参数
    cwd: z.string().optional(), // 工作目录
    title: z.string().optional(), // 标题
    env: z.record(z.string(), z.string()).optional(), // 环境变量
  })

  export type CreateInput = z.infer<typeof CreateInput>

  /**
   * 更新终端的输入参数 Schema
   */
  export const UpdateInput = z.object({
    title: z.string().optional(), // 更新标题
    size: z // 更新终端大小
      .object({
        rows: z.number(), // 行数
        cols: z.number(), // 列数
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  /**
   * PTY 相关事件定义
   */
  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })), // 终端创建
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })), // 终端更新
    Exited: BusEvent.define("pty.exited", z.object({ id: Identifier.schema("pty"), exitCode: z.number() })), // 终端退出
    Deleted: BusEvent.define("pty.deleted", z.object({ id: Identifier.schema("pty") })), // 终端删除
  }

  /**
   * 活动会话内部接口
   */
  interface ActiveSession {
    info: Info // 会话信息
    process: IPty // PTY 进程
    buffer: string // 输出缓冲区
    subscribers: Set<WSContext> // WebSocket 订阅者
  }

  /**
   * 会话状态管理
   * 使用 Instance.state 确保每个项目独立，并提供清理函数
   */
  const state = Instance.state(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      // 清理时关闭所有会话
      for (const session of sessions.values()) {
        try {
          session.process.kill()
        } catch {}
        for (const ws of session.subscribers) {
          ws.close()
        }
      }
      sessions.clear()
    },
  )

  /**
   * 获取所有活动会话列表
   */
  export function list() {
    return Array.from(state().values()).map((s) => s.info)
  }

  /**
   * 获取指定会话信息
   */
  export function get(id: string) {
    return state().get(id)?.info
  }

  /**
   * 创建新的终端会话
   *
   * @param input - 创建参数
   * @returns 会话信息
   */
  export async function create(input: CreateInput) {
    const id = Identifier.create("pty", false)
    const command = input.command || Shell.preferred() // 默认使用首选 Shell
    const args = input.args || []
    // 对于 Shell 命令，添加登录 Shell 参数
    if (command.endsWith("sh")) {
      args.push("-l")
    }

    const cwd = input.cwd || Instance.directory
    // 设置终端环境变量
    const env = { ...process.env, ...input.env, TERM: "xterm-256color" } as Record<string, string>
    log.info("creating session", { id, cmd: command, args, cwd })

    // 创建 PTY 进程
    const spawn = await pty()
    const ptyProcess = spawn(command, args, {
      name: "xterm-256color",
      cwd,
      env,
    })

    // 创建会话信息
    const info = {
      id,
      title: input.title || `Terminal ${id.slice(-4)}`, // 默认标题使用 ID 后 4 位
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
    } as const
    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: "",
      subscribers: new Set(),
    }
    state().set(id, session)

    // 监听 PTY 输出
    ptyProcess.onData((data) => {
      let open = false
      // 向所有连接的 WebSocket 发送数据
      for (const ws of session.subscribers) {
        if (ws.readyState !== 1) {
          session.subscribers.delete(ws) // 清理已关闭的连接
          continue
        }
        open = true
        ws.send(data)
      }
      if (open) return
      // 没有连接时缓存输出
      session.buffer += data
      if (session.buffer.length <= BUFFER_LIMIT) return
      session.buffer = session.buffer.slice(-BUFFER_LIMIT) // 限制缓冲区大小
    })

    // 监听进程退出
    ptyProcess.onExit(({ exitCode }) => {
      log.info("session exited", { id, exitCode })
      session.info.status = "exited"
      Bus.publish(Event.Exited, { id, exitCode })
      state().delete(id)
    })

    Bus.publish(Event.Created, { info })
    return info
  }

  /**
   * 更新终端会话属性
   */
  export async function update(id: string, input: UpdateInput) {
    const session = state().get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title // 更新标题
    }
    if (input.size) {
      session.process.resize(input.size.cols, input.size.rows) // 调整大小
    }
    Bus.publish(Event.Updated, { info: session.info })
    return session.info
  }

  /**
   * 删除终端会话
   */
  export async function remove(id: string) {
    const session = state().get(id)
    if (!session) return
    log.info("removing session", { id })
    try {
      session.process.kill() // 终止进程
    } catch {}
    // 关闭所有 WebSocket 连接
    for (const ws of session.subscribers) {
      ws.close()
    }
    state().delete(id)
    Bus.publish(Event.Deleted, { id })
  }

  /**
   * 调整终端大小
   */
  export function resize(id: string, cols: number, rows: number) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.resize(cols, rows)
    }
  }

  /**
   * 向终端写入数据
   */
  export function write(id: string, data: string) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.write(data)
    }
  }

  /**
   * 连接 WebSocket 到终端会话
   *
   * @param id - 会话 ID
   * @param ws - WebSocket 上下文
   * @returns 消息处理器，会话不存在时返回 undefined
   */
  export function connect(id: string, ws: WSContext) {
    const session = state().get(id)
    if (!session) {
      ws.close() // 会话不存在，关闭连接
      return
    }
    log.info("client connected to session", { id })
    session.subscribers.add(ws) // 添加订阅者

    // 发送缓冲区中的历史输出
    if (session.buffer) {
      const buffer = session.buffer.length <= BUFFER_LIMIT ? session.buffer : session.buffer.slice(-BUFFER_LIMIT)
      session.buffer = "" // 清空缓冲区
      try {
        // 分块发送
        for (let i = 0; i < buffer.length; i += BUFFER_CHUNK) {
          ws.send(buffer.slice(i, i + BUFFER_CHUNK))
        }
      } catch {
        // 发送失败，恢复缓冲区
        session.subscribers.delete(ws)
        session.buffer = buffer
        ws.close()
        return
      }
    }

    // 返回消息处理器
    return {
      onMessage: (message: string | ArrayBuffer) => {
        session.process.write(String(message)) // 转发到 PTY
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws) // 移除订阅者
      },
    }
  }
}
