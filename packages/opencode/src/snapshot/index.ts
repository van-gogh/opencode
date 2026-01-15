/**
 * Snapshot 模块 - 文件快照管理
 *
 * 本模块提供文件系统快照功能，用于跟踪和恢复文件更改。
 * 基于 Git 的内部机制实现，使用独立的 .git 目录存储快照数据。
 *
 * 主要功能：
 * - track(): 创建当前状态快照
 * - patch(): 获取快照与当前状态的差异文件列表
 * - diff(): 获取详细的 diff 内容
 * - restore(): 恢复到指定快照
 * - revert(): 选择性恢复文件
 *
 * 应用场景：
 * - AI 编辑前创建快照，便于回滚
 * - 跟踪会话中的文件更改
 * - 生成会话结束时的 diff 摘要
 *
 * @module snapshot
 */

import { $ } from "bun" // Bun shell 命令
import path from "path" // 路径处理
import fs from "fs/promises" // 文件系统操作
import { Log } from "../util/log" // 日志工具
import { Global } from "../global" // 全局路径
import z from "zod" // 参数验证
import { Config } from "../config/config" // 配置管理
import { Instance } from "../project/instance" // 项目实例

/**
 * Snapshot 命名空间
 *
 * 提供文件快照的创建、查询和恢复接口
 */
export namespace Snapshot {
  // 快照模块的日志记录器
  const log = Log.create({ service: "snapshot" })

  /**
   * 创建当前状态的快照
   *
   * 将工作目录的当前状态记录为 Git tree 对象
   *
   * @returns 快照哈希值，可用于后续的 diff 或 restore 操作
   */
  export async function track() {
    // 仅在 Git 项目中支持快照
    if (Instance.project.vcs !== "git") return
    const cfg = await Config.get()
    // 检查是否禁用快照功能
    if (cfg.snapshot === false) return
    const git = gitdir() // 获取快照存储目录
    // 初始化快照仓库（如果不存在）
    if (await fs.mkdir(git, { recursive: true })) {
      await $`git init`
        .env({
          ...process.env,
          GIT_DIR: git, // 使用独立的 Git 目录
          GIT_WORK_TREE: Instance.worktree,
        })
        .quiet()
        .nothrow()
      // 配置 Git 不转换行尾符（Windows 兼容）
      await $`git --git-dir ${git} config core.autocrlf false`.quiet().nothrow()
      log.info("initialized")
    }
    // 添加所有文件到索引
    await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`.quiet().cwd(Instance.directory).nothrow()
    // 创建 tree 对象，返回哈希值
    const hash = await $`git --git-dir ${git} --work-tree ${Instance.worktree} write-tree`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .text()
    log.info("tracking", { hash, cwd: Instance.directory, git })
    return hash.trim()
  }

  /**
   * 补丁信息 Schema
   *
   * 记录快照哈希和变更的文件列表
   */
  export const Patch = z.object({
    hash: z.string(), // 快照哈希
    files: z.string().array(), // 变更的文件路径列表
  })
  export type Patch = z.infer<typeof Patch>

  /**
   * 获取快照与当前状态的差异文件
   *
   * @param hash - 快照哈希
   * @returns 包含快照哈希和变更文件列表的 Patch 对象
   */
  export async function patch(hash: string): Promise<Patch> {
    const git = gitdir()
    // 确保索引是最新的
    await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`.quiet().cwd(Instance.directory).nothrow()
    // 获取变更的文件名列表
    const result =
      await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --name-only ${hash} -- .`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()

    // 如果 git diff 失败，返回空补丁
    if (result.exitCode !== 0) {
      log.warn("failed to get diff", { hash, exitCode: result.exitCode })
      return { hash, files: [] }
    }

    const files = result.text()
    return {
      hash,
      // 解析文件列表并转换为绝对路径
      files: files
        .trim()
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => path.join(Instance.worktree, x)),
    }
  }

  /**
   * 完整恢复到指定快照
   *
   * 将工作目录恢复到快照时的状态
   *
   * @param snapshot - 快照哈希
   */
  export async function restore(snapshot: string) {
    log.info("restore", { commit: snapshot })
    const git = gitdir()
    // 使用 read-tree 和 checkout-index 恢复文件
    const result =
      await $`git --git-dir ${git} --work-tree ${Instance.worktree} read-tree ${snapshot} && git --git-dir ${git} --work-tree ${Instance.worktree} checkout-index -a -f`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()

    if (result.exitCode !== 0) {
      log.error("failed to restore snapshot", {
        snapshot,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
    }
  }

  /**
   * 选择性恢复文件
   *
   * 根据补丁列表恢复特定文件到快照状态
   *
   * @param patches - 补丁列表，每个补丁包含快照哈希和文件列表
   */
  export async function revert(patches: Patch[]) {
    const files = new Set<string>() // 已处理的文件集合，避免重复处理
    const git = gitdir()
    for (const item of patches) {
      for (const file of item.files) {
        if (files.has(file)) continue // 跳过已处理的文件
        log.info("reverting", { file, hash: item.hash })
        // 尝试从快照中恢复文件
        const result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} checkout ${item.hash} -- ${file}`
          .quiet()
          .cwd(Instance.worktree)
          .nothrow()
        if (result.exitCode !== 0) {
          // 恢复失败，检查文件是否在快照中存在
          const relativePath = path.relative(Instance.worktree, file)
          const checkTree =
            await $`git --git-dir ${git} --work-tree ${Instance.worktree} ls-tree ${item.hash} -- ${relativePath}`
              .quiet()
              .cwd(Instance.worktree)
              .nothrow()
          if (checkTree.exitCode === 0 && checkTree.text().trim()) {
            // 文件在快照中存在但恢复失败，保留当前文件
            log.info("file existed in snapshot but checkout failed, keeping", {
              file,
            })
          } else {
            // 文件在快照中不存在，删除当前文件
            log.info("file did not exist in snapshot, deleting", { file })
            await fs.unlink(file).catch(() => {})
          }
        }
        files.add(file)
      }
    }
  }

  /**
   * 获取快照与当前状态的 diff 内容
   *
   * @param hash - 快照哈希
   * @returns diff 字符串
   */
  export async function diff(hash: string) {
    const git = gitdir()
    // 确保索引是最新的
    await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`.quiet().cwd(Instance.directory).nothrow()
    // 获取 diff 内容
    const result =
      await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff ${hash} -- .`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
      return ""
    }

    return result.text().trim()
  }

  /**
   * 文件差异 Schema
   *
   * 记录单个文件的变更详情
   */
  export const FileDiff = z
    .object({
      file: z.string(), // 文件路径
      before: z.string(), // 变更前内容
      after: z.string(), // 变更后内容
      additions: z.number(), // 新增行数
      deletions: z.number(), // 删除行数
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>
  /**
   * 获取两个快照之间的完整差异
   *
   * 包含每个文件的前后内容和统计信息
   *
   * @param from - 起始快照哈希
   * @param to - 目标快照哈希
   * @returns 文件差异数组
   */
  export async function diffFull(from: string, to: string): Promise<FileDiff[]> {
    const git = gitdir()
    const result: FileDiff[] = []
    // 使用 numstat 获取每个文件的增删统计
    for await (const line of $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --no-renames --numstat ${from} ${to} -- .`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .lines()) {
      if (!line) continue
      // 解析 numstat 输出格式：新增数\t删除数\t文件名
      const [additions, deletions, file] = line.split("\t")
      // 二进制文件的统计为 "-"
      const isBinaryFile = additions === "-" && deletions === "-"
      // 获取文件变更前的内容
      const before = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} show ${from}:${file}`
            .quiet()
            .nothrow()
            .text()
      // 获取文件变更后的内容
      const after = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} show ${to}:${file}`
            .quiet()
            .nothrow()
            .text()
      // 解析增删统计
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      result.push({
        file,
        before,
        after,
        additions: Number.isFinite(added) ? added : 0,
        deletions: Number.isFinite(deleted) ? deleted : 0,
      })
    }
    return result
  }

  /**
   * 获取快照存储目录
   *
   * 每个项目使用独立的 Git 目录存储快照
   *
   * @returns 快照 Git 目录路径
   */
  function gitdir() {
    const project = Instance.project
    return path.join(Global.Path.data, "snapshot", project.id)
  }
}
