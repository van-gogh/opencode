/**
 * State 模块 - 状态管理
 *
 * 本模块提供项目级别的状态管理功能。
 *
 * 主要功能：
 * - 状态创建：基于初始化函数创建状态
 * - 状态缓存：相同初始化函数复用同一状态
 * - 状态销毁：清理项目的所有状态
 * - 超时警告：状态销毁超时时警告
 *
 * @module project/state
 */
import { Log } from "@/util/log" // 日志

/**
 * State 命名空间
 *
 * 提供状态管理功能
 */
export namespace State {
  /**
   * 状态条目接口
   */
  interface Entry {
    state: any // 状态值
    dispose?: (state: any) => Promise<void> // 销毁函数
  }

  // 创建状态模块日志记录器
  const log = Log.create({ service: "state" })

  // 状态记录表，按项目键分组
  const recordsByKey = new Map<string, Map<any, Entry>>()

  /**
   * 创建状态获取函数
   *
   * 返回一个函数，调用时返回状态实例。
   * 相同的初始化函数会返回同一个状态实例。
   *
   * @param root - 获取状态键的函数（通常是项目目录）
   * @param init - 状态初始化函数
   * @param dispose - 状态销毁函数（可选）
   * @returns 状态获取函数
   */
  export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    return () => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose,
      })
      return state
    }
  }

  /**
   * 销毁指定键的所有状态
   *
   * 调用每个状态的 dispose 函数，并清理缓存。
   * 如果销毁超过 10 秒，会记录警告。
   *
   * @param key - 状态键（通常是项目目录）
   */
  export async function dispose(key: string) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    let disposalFinished = false

    setTimeout(() => {
      if (!disposalFinished) {
        log.warn(
          "state disposal is taking an unusually long time - if it does not complete in a reasonable time, please report this as a bug",
          { key },
        )
      }
    }, 10000).unref()

    const tasks: Promise<void>[] = []
    for (const entry of entries.values()) {
      if (!entry.dispose) continue

      const task = Promise.resolve(entry.state)
        .then((state) => entry.dispose!(state))
        .catch((error) => {
          log.error("Error while disposing state:", { error, key })
        })

      tasks.push(task)
    }
    entries.clear()
    recordsByKey.delete(key)
    await Promise.all(tasks)
    disposalFinished = true
    log.info("state disposal completed", { key })
  }
}
