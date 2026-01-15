/**
 * VCS 模块 - 版本控制系统集成
 *
 * 本模块提供 Git 版本控制集成功能。
 *
 * 主要功能：
 * - 分支监控：监听当前分支变化
 * - 事件通知：分支切换时发送事件
 * - 文件监控：通过 HEAD 文件变化检测分支切换
 *
 * @module project/vcs
 */
import { BusEvent } from "@/bus/bus-event" // 事件定义
import { Bus } from "@/bus" // 事件总线
import { $ } from "bun" // Shell 命令
import path from "path" // 路径处理
import z from "zod" // Schema 验证
import { Log } from "@/util/log" // 日志
import { Instance } from "./instance" // 项目实例
import { FileWatcher } from "@/file/watcher" // 文件监控

// 创建 VCS 模块日志记录器
const log = Log.create({ service: "vcs" })

/**
 * Vcs 命名空间
 *
 * 提供 Git 版本控制集成
 */
export namespace Vcs {
  /** VCS 事件定义 */
  export const Event = {
    /** 分支更新事件 */
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(), // 新分支名称
      }),
    ),
  }

  /**
   * VCS 信息类型
   */
  export const Info = z
    .object({
      branch: z.string(), // 当前分支名称
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  /**
   * 获取当前 Git 分支
   *
   * @returns 当前分支名称
   */
  async function currentBranch() {
    return $`git rev-parse --abbrev-ref HEAD`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then((x) => x.trim())
      .catch(() => undefined)
  }

  /**
   * VCS 状态
   *
   * 初始化时设置分支监控
   */
  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await currentBranch()
      log.info("initialized", { branch: current })

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, async (evt) => {
        if (evt.properties.file.endsWith("HEAD")) return
        const next = await currentBranch()
        if (next !== current) {
          log.info("branch changed", { from: current, to: next })
          current = next
          Bus.publish(Event.BranchUpdated, { branch: next })
        }
      })

      return {
        branch: async () => current,
        unsubscribe,
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  /**
   * 初始化 VCS 模块
   *
   * @returns VCS 状态
   */
  export async function init() {
    return state()
  }

  /**
   * 获取当前分支
   *
   * @returns 当前分支名称
   */
  export async function branch() {
    return await state().then((s) => s.branch())
  }
}
