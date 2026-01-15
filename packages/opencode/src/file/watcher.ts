/**
 * FileWatcher 模块 - 文件监控
 *
 * 本模块提供文件系统变更监控功能。
 *
 * 主要功能：
 * - 监控文件创建、修改、删除事件
 * - 支持多平台（Windows, macOS, Linux）
 * - 自动忽略不需要监控的文件
 * - 监控 Git HEAD 文件以检测分支切换
 *
 * 使用 @parcel/watcher 作为底层实现
 *
 * @module file/watcher
 */
import { BusEvent } from "@/bus/bus-event" // 事件定义
import { Bus } from "@/bus" // 事件总线
import z from "zod" // Schema 验证
import { Instance } from "../project/instance" // 项目实例
import { Log } from "../util/log" // 日志
import { FileIgnore } from "./ignore" // 忽略配置
import { Config } from "../config/config" // 配置
import path from "path" // 路径处理
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper" // Watcher 包装
import { lazy } from "@/util/lazy" // 懒加载
import { withTimeout } from "@/util/timeout" // 超时工具
import type ParcelWatcher from "@parcel/watcher" // Watcher 类型
import { $ } from "bun" // Shell 命令
import { Flag } from "@/flag/flag" // 功能标志
import { readdir } from "fs/promises" // 文件系统

/** 订阅超时时间（毫秒） */
const SUBSCRIBE_TIMEOUT_MS = 10_000

// libc 类型声明（用于 Linux 平台）
declare const OPENCODE_LIBC: string | undefined

/**
 * FileWatcher 命名空间
 *
 * 提供文件监控功能
 */
export namespace FileWatcher {
  // 创建文件监控模块日志记录器
  const log = Log.create({ service: "file.watcher" })

  /** 文件监控事件定义 */
  export const Event = {
    /** 文件更新事件 */
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(), // 文件路径
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]), // 事件类型
      }),
    ),
  }

  /**
   * 懒加载 Watcher 实例
   *
   * 根据平台加载对应的 native binding
   */
  const watcher = lazy(() => {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  })

  /**
   * FileWatcher 状态
   *
   * 初始化时设置文件监控
   */
  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") return {}
      log.info("init")
      const cfg = await Config.get()
      const backend = (() => {
        if (process.platform === "win32") return "windows"
        if (process.platform === "darwin") return "fs-events"
        if (process.platform === "linux") return "inotify"
      })()
      if (!backend) {
        log.error("watcher backend not supported", { platform: process.platform })
        return {}
      }
      log.info("watcher backend", { platform: process.platform, backend })
      const subscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
        if (err) return
        for (const evt of evts) {
          if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
          if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
          if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
        }
      }

      const subs: ParcelWatcher.AsyncSubscription[] = []
      const cfgIgnores = cfg.watcher?.ignore ?? []

      if (Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER) {
        const pending = watcher().subscribe(Instance.directory, subscribe, {
          ignore: [...FileIgnore.PATTERNS, ...cfgIgnores],
          backend,
        })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to Instance.directory", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      const vcsDir = await $`git rev-parse --git-dir`
        .quiet()
        .nothrow()
        .cwd(Instance.worktree)
        .text()
        .then((x) => path.resolve(Instance.worktree, x.trim()))
        .catch(() => undefined)
      if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
        const gitDirContents = await readdir(vcsDir).catch(() => [])
        const ignoreList = gitDirContents.filter((entry) => entry !== "HEAD")
        const pending = watcher().subscribe(vcsDir, subscribe, {
          ignore: ignoreList,
          backend,
        })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to vcsDir", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      return { subs }
    },
    async (state) => {
      if (!state.subs) return
      await Promise.all(state.subs.map((sub) => sub?.unsubscribe()))
    },
  )

  /**
   * 初始化文件监控
   *
   * 如果已禁用则不执行任何操作
   */
  export function init() {
    if (Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) {
      return
    }
    state()
  }
}
