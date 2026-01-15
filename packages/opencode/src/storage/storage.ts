/**
 * Storage 模块 - 数据存储层
 *
 * 本模块提供了 OpenCode 的数据持久化功能，基于 JSON 文件存储。
 * 主要功能：
 * - 读取、写入、更新、删除数据
 * - 数据迁移管理
 * - 文件锁保证并发安全
 *
 * 存储结构：
 * - 使用分层键结构，如 ["session", projectID, sessionID]
 * - 每个键对应一个 .json 文件
 * - 存储位置在全局数据目录下的 storage 文件夹
 *
 * @module storage
 */

import { Log } from "../util/log" // 日志工具
import path from "path" // 路径处理
import fs from "fs/promises" // 文件系统操作
import { Global } from "../global" // 全局路径配置
import { lazy } from "../util/lazy" // 延迟初始化工具
import { Lock } from "../util/lock" // 文件锁工具
import { $ } from "bun" // Bun shell 命令
import { NamedError } from "@opencode-ai/util/error" // 命名错误类
import z from "zod" // 参数验证

/**
 * Storage 命名空间
 *
 * 提供统一的数据存储接口
 */
export namespace Storage {
  // 创建 Storage 模块专用的日志记录器
  const log = Log.create({ service: "storage" })

  /**
   * 迁移函数类型
   * 每个迁移函数接收存储目录并执行迁移操作
   */
  type Migration = (dir: string) => Promise<void>

  /**
   * 资源未找到错误
   * 当读取不存在的数据时抛出
   */
  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  /**
   * 数据迁移列表
   *
   * 每个迁移按顺序执行，用于升级旧版本的数据结构
   * 迁移进度保存在 storage/migration 文件中
   */
  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!fs.exists(project)) return
      for await (const projectDir of new Bun.Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Bun.file(msgFile).json()
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await fs.exists(worktree))) continue
          const [id] = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(worktree)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
          if (!id) continue
          projectID = id

          await Bun.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Bun.file(sessionFile).json()
            await Bun.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Bun.file(msgFile).json()
              await Bun.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Bun.Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan(
                {
                  cwd: fullProjectDir,
                  absolute: true,
                },
              )) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Bun.file(partFile).json()
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Bun.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Bun.Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Bun.file(item).json()
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Bun.file(path.join(dir, "session_diff", session.id + ".json")).write(JSON.stringify(diffs))
        await Bun.file(path.join(dir, "session", session.projectID, session.id + ".json")).write(
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
  ]

  /**
   * 存储状态初始化
   *
   * 使用 lazy 确保只初始化一次：
   * 1. 确定存储目录
   * 2. 运行待执行的数据迁移
   */
  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    // 读取当前迁移进度
    const migration = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)
    // 执行尚未完成的迁移
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      // 更新迁移进度
      await Bun.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  /**
   * 删除数据
   *
   * @param key - 分层键数组，如 ["session", projectID, sessionID]
   */
  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch(() => {})
    })
  }

  /**
   * 读取数据
   *
   * 使用读锁保证并发安全
   *
   * @param key - 分层键数组
   * @returns 解析后的 JSON 数据
   * @throws NotFoundError 如果数据不存在
   */
  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target) // 获取读锁
      const result = await Bun.file(target).json()
      return result as T
    })
  }

  /**
   * 更新数据
   *
   * 读取现有数据，应用修改函数，然后写回
   * 使用写锁保证原子性
   *
   * @param key - 分层键数组
   * @param fn - 修改函数，接收当前数据作为参数
   * @returns 修改后的数据
   */
  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target) // 获取写锁
      const content = await Bun.file(target).json()
      fn(content) // 应用修改
      await Bun.write(target, JSON.stringify(content, null, 2))
      return content as T
    })
  }

  /**
   * 写入数据
   *
   * 直接覆盖现有数据，使用写锁保证并发安全
   *
   * @param key - 分层键数组
   * @param content - 要写入的数据
   */
  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target) // 获取写锁
      await Bun.write(target, JSON.stringify(content, null, 2))
    })
  }

  /**
   * 错误处理包装器
   *
   * 将文件系统错误转换为更友好的错误类型
   */
  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      // 文件不存在错误转换为 NotFoundError
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  // 用于列出目录内容的 glob 模式
  const glob = new Bun.Glob("**/*")

  /**
   * 列出指定前缀下的所有键
   *
   * @param prefix - 键前缀数组，如 ["session", projectID]
   * @returns 所有匹配的键数组
   */
  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
