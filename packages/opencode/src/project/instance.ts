/**
 * Instance 模块 - 项目实例管理
 *
 * 本模块管理项目实例的生命周期和上下文。
 *
 * 主要功能：
 * - 提供项目上下文（目录、工作树、项目信息）
 * - 管理项目级别的状态
 * - 实例缓存和复用
 * - 实例的创建和销毁
 *
 * @module project/instance
 */
import { Log } from "@/util/log" // 日志
import { Context } from "../util/context" // 上下文工具
import { Project } from "./project" // 项目模块
import { State } from "./state" // 状态管理
import { iife } from "@/util/iife" // 立即执行
import { GlobalBus } from "@/bus/global" // 全局事件总线

/**
 * 实例上下文类型
 */
interface Context {
  directory: string // 工作目录
  worktree: string // 工作树根目录
  project: Project.Info // 项目信息
}

// 创建上下文容器
const context = Context.create<Context>("instance")

// 实例缓存，按目录缓存
const cache = new Map<string, Promise<Context>>()

/**
 * Instance 对象
 *
 * 提供项目实例的访问和管理
 */
export const Instance = {
  /**
   * 在指定目录的上下文中执行函数
   *
   * 如果实例不存在，则创建新实例；
   * 如果已存在，则复用缓存的实例。
   *
   * @param input.directory - 工作目录
   * @param input.init - 初始化函数（可选）
   * @param input.fn - 要执行的函数
   * @returns 函数执行结果
   */
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    let existing = cache.get(input.directory)
    if (!existing) {
      Log.Default.info("creating instance", { directory: input.directory })
      existing = iife(async () => {
        const { project, sandbox } = await Project.fromDirectory(input.directory)
        const ctx = {
          directory: input.directory,
          worktree: sandbox,
          project,
        }
        await context.provide(ctx, async () => {
          await input.init?.()
        })
        return ctx
      })
      cache.set(input.directory, existing)
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  /** 获取当前工作目录 */
  get directory() {
    return context.use().directory
  },
  /** 获取当前工作树根目录 */
  get worktree() {
    return context.use().worktree
  },
  /** 获取当前项目信息 */
  get project() {
    return context.use().project
  },
  /**
   * 创建项目级别的状态
   *
   * 为当前项目创建独立的状态实例。
   * 相同项目共享同一状态。
   *
   * @param init - 状态初始化函数
   * @param dispose - 状态销毁函数（可选）
   * @returns 状态获取函数
   */
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => Instance.directory, init, dispose)
  },
  /**
   * 销毁当前实例
   *
   * 清理实例的所有状态和资源
   */
  async dispose() {
    Log.Default.info("disposing instance", { directory: Instance.directory })
    await State.dispose(Instance.directory)
    cache.delete(Instance.directory)
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory: Instance.directory,
        },
      },
    })
  },
  /**
   * 销毁所有实例
   *
   * 清理所有缓存的实例
   */
  async disposeAll() {
    Log.Default.info("disposing all instances")
    for (const [_key, value] of cache) {
      const awaited = await value.catch(() => {})
      if (awaited) {
        await context.provide(await value, async () => {
          await Instance.dispose()
        })
      }
    }
    cache.clear()
  },
}
