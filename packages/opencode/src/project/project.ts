/**
 * Project 模块 - 项目管理
 *
 * 本模块负责项目的识别、初始化和管理。
 *
 * 主要功能：
 * - 项目识别：通过 Git 仓库识别项目
 * - 项目 ID 生成：基于 Git 根提交生成唯一 ID
 * - 会话迁移：将 global 项目的会话迁移到新项目
 * - 图标发现：自动发现项目图标
 * - 沙箱管理：支持多个工作树（worktree）
 *
 * @module project/project
 */
import z from "zod" // Schema 验证
import fs from "fs/promises" // 文件系统
import { Filesystem } from "../util/filesystem" // 文件系统工具
import path from "path" // 路径处理
import { $ } from "bun" // Shell 命令
import { Storage } from "../storage/storage" // 存储
import { Log } from "../util/log" // 日志
import { Flag } from "@/flag/flag" // 功能标志
import { Session } from "../session" // 会话
import { work } from "../util/queue" // 并发工具
import { fn } from "@opencode-ai/util/fn" // 函数包装
import { BusEvent } from "@/bus/bus-event" // 事件定义
import { iife } from "@/util/iife" // 立即执行
import { GlobalBus } from "@/bus/global" // 全局事件总线
import { existsSync } from "fs" // 文件存在检查

/**
 * Project 命名空间
 *
 * 提供项目管理功能
 */
export namespace Project {
  // 创建项目模块专用日志记录器
  const log = Log.create({ service: "project" })
  /**
   * 项目信息定义
   * 包含项目 ID、工作树路径、VCS 类型、名称、图标、时间戳和沙盒列表
   */
  export const Info = z
    .object({
      id: z.string(), // 项目唯一标识
      worktree: z.string(), // 工作树根目录
      vcs: z.literal("git").optional(), // 版本控制系统类型
      name: z.string().optional(), // 项目名称
      icon: z
        .object({
          url: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(), // 项目图标配置
      time: z.object({
        created: z.number(), // 创建时间
        updated: z.number(), // 更新时间
        initialized: z.number().optional(), // 初始化时间
      }),
      sandboxes: z.array(z.string()), // 关联的沙盒目录列表
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  /** 项目事件定义 */
  export const Event = {
    /** 项目更新事件 */
    Updated: BusEvent.define("project.updated", Info),
  }

  /**
   * 从目录加载或创建项目
   * 自动识别 Git 根目录作为项目根目录，生成或读取项目 ID
   * @param directory 起始目录
   */
  export async function fromDirectory(directory: string) {
    log.info("fromDirectory", { directory })

    const { id, sandbox, worktree, vcs } = await iife(async () => {
      // 向上查找 .git 目录
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const git = await matches.next().then((x) => x.value)
      await matches.return()
      if (git) {
        let sandbox = path.dirname(git)

        const gitBinary = Bun.which("git")

        // 尝试读取缓存的项目 ID
        let id = await Bun.file(path.join(git, "opencode"))
          .text()
          .then((x) => x.trim())
          .catch(() => undefined)

        if (!gitBinary) {
          return {
            id: id ?? "global",
            worktree: sandbox,
            sandbox: sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        // 如果没有 ID，则根据 Git 根提交生成 ID
        if (!id) {
          const roots = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(sandbox)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
            .catch(() => undefined)

          if (!roots) {
            return {
              id: "global",
              worktree: sandbox,
              sandbox: sandbox,
              vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
            }
          }

          id = roots[0]
          if (id) {
            // 将生成的 ID 写入文件以供后续使用
            void Bun.file(path.join(git, "opencode"))
              .write(id)
              .catch(() => undefined)
          }
        }

        if (!id) {
          return {
            id: "global",
            worktree: sandbox,
            sandbox: sandbox,
            vcs: "git",
          }
        }

        // 获取 Git 顶级目录
        const top = await $`git rev-parse --show-toplevel`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => path.resolve(sandbox, x.trim()))
          .catch(() => undefined)

        if (!top) {
          return {
            id,
            sandbox,
            worktree: sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        sandbox = top

        // 获取 Git 公共目录（处理 worktree 的情况）
        const worktree = await $`git rev-parse --git-common-dir`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => {
            const dirname = path.dirname(x.trim())
            if (dirname === ".") return sandbox
            return dirname
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id,
            sandbox,
            worktree: sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        return {
          id,
          sandbox,
          worktree,
          vcs: "git",
        }
      }

      return {
        id: "global",
        worktree: "/",
        sandbox: "/",
        vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
      }
    })

    // 读取或初始化项目存储
    let existing = await Storage.read<Info>(["project", id]).catch(() => undefined)
    if (!existing) {
      existing = {
        id,
        worktree,
        vcs: vcs as Info["vcs"],
        sandboxes: [],
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      if (id !== "global") {
        await migrateFromGlobal(id, worktree)
      }
    }

    // 迁移旧项目数据
    if (!existing.sandboxes) existing.sandboxes = []

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(existing)
    const result: Info = {
      ...existing,
      worktree,
      vcs: vcs as Info["vcs"],
      time: {
        ...existing.time,
        updated: Date.now(),
      },
    }
    if (sandbox !== result.worktree && !result.sandboxes.includes(sandbox)) result.sandboxes.push(sandbox)
    result.sandboxes = result.sandboxes.filter((x) => existsSync(x))
    await Storage.write<Info>(["project", id], result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox }
  }

  /**
   * 自动发现项目图标
   * 在项目中查找 favicon 等图标文件并更新项目配置
   */
  export async function discover(input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.url) return
    const glob = new Bun.Glob("**/{favicon}.{ico,png,svg,jpg,jpeg,webp}")
    const matches = await Array.fromAsync(
      glob.scan({
        cwd: input.worktree,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
        dot: false,
      }),
    )
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const file = Bun.file(shortest)
    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString("base64")
    const mime = file.type || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update({
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  /**
   * 从全局项目迁移会话
   * 当检测到新项目时，将之前属于 global 项目但在该目录下的会话迁移过来
   */
  async function migrateFromGlobal(newProjectID: string, worktree: string) {
    const globalProject = await Storage.read<Info>(["project", "global"]).catch(() => undefined)
    if (!globalProject) return

    const globalSessions = await Storage.list(["session", "global"]).catch(() => [])
    if (globalSessions.length === 0) return

    log.info("migrating sessions from global", { newProjectID, worktree, count: globalSessions.length })

    await work(10, globalSessions, async (key) => {
      const sessionID = key[key.length - 1]
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session) return
      if (session.directory && session.directory !== worktree) return

      session.projectID = newProjectID
      log.info("migrating session", { sessionID, from: "global", to: newProjectID })
      await Storage.write(["session", newProjectID, sessionID], session)
      await Storage.remove(key)
    }).catch((error) => {
      log.error("failed to migrate sessions from global to project", { error, projectId: newProjectID })
    })
  }

  /**
   * 设置项目已初始化
   *
   * @param projectID - 项目 ID
   */
  export async function setInitialized(projectID: string) {
    await Storage.update<Info>(["project", projectID], (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  /**
   * 获取所有项目列表
   *
   * @returns 项目信息数组
   */
  export async function list() {
    const keys = await Storage.list(["project"])
    return await Promise.all(keys.map((x) => Storage.read<Info>(x)))
  }

  /**
   * 更新项目信息
   *
   * 支持更新项目名称和图标
   */
  export const update = fn(
    z.object({
      projectID: z.string(),
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
    }),
    async (input) => {
      const result = await Storage.update<Info>(["project", input.projectID], (draft) => {
        if (input.name !== undefined) draft.name = input.name
        if (input.icon !== undefined) {
          draft.icon = {
            ...draft.icon,
          }
          if (input.icon.url !== undefined) draft.icon.url = input.icon.url
          if (input.icon.color !== undefined) draft.icon.color = input.icon.color
        }
        draft.time.updated = Date.now()
      })
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: result,
        },
      })
      return result
    },
  )

  /**
   * 获取项目的所有沙箱目录
   *
   * 返回仍然存在的沙箱目录列表
   *
   * @param projectID - 项目 ID
   * @returns 有效的沙箱目录数组
   */
  export async function sandboxes(projectID: string) {
    const project = await Storage.read<Info>(["project", projectID]).catch(() => undefined)
    if (!project?.sandboxes) return []
    const valid: string[] = []
    for (const dir of project.sandboxes) {
      const stat = await fs.stat(dir).catch(() => undefined)
      if (stat?.isDirectory()) valid.push(dir)
    }
    return valid
  }
}
