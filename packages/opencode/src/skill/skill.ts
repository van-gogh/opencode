/**
 * Skill 模块 - 技能管理
 *
 * 本模块提供技能（Skill）管理功能。技能是预定义的知识/提示词模板，
 * 存储在 SKILL.md 文件中，可在对话中被 AI 调用。
 *
 * 技能搜索位置（按优先级）：
 * 1. 项目目录的 .claude/skills/ 目录
 * 2. 全局配置 ~/.claude/skills/ 目录
 * 3. 项目目录的 .opencode/skill/ 或 skills/ 目录
 *
 * SKILL.md 文件格式：
 * ```markdown
 * ---
 * name: skill-name
 * description: Skill description
 * ---
 * Skill content...
 * ```
 *
 * @module skill
 */

import z from "zod" // 参数验证
import { Config } from "../config/config" // 配置管理
import { Instance } from "../project/instance" // 项目实例
import { NamedError } from "@opencode-ai/util/error" // 命名错误类
import { ConfigMarkdown } from "../config/markdown" // Markdown 配置解析
import { Log } from "../util/log" // 日志工具
import { Global } from "@/global" // 全局路径
import { Filesystem } from "@/util/filesystem" // 文件系统工具
import { exists } from "fs/promises" // 文件存在检查

/**
 * Skill 命名空间
 *
 * 提供技能的搜索、加载和管理接口
 */
export namespace Skill {
  // 技能模块的日志记录器
  const log = Log.create({ service: "skill" })

  /**
   * 技能信息 Schema
   *
   * 定义技能的元数据结构
   */
  export const Info = z.object({
    name: z.string(), // 技能名称，用于引用
    description: z.string(), // 技能描述，用于 AI 理解技能用途
    location: z.string(), // 技能文件路径
  })
  export type Info = z.infer<typeof Info>

  /**
   * 技能无效错误
   *
   * 当 SKILL.md 文件格式不正确时抛出
   */
  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(), // 文件路径
      message: z.string().optional(), // 错误消息
      issues: z.custom<z.core.$ZodIssue[]>().optional(), // Zod 验证错误
    }),
  )

  /**
   * 技能名称不匹配错误
   *
   * 当文件名与内容中的技能名不一致时抛出
   */
  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(), // 文件路径
      expected: z.string(), // 期望的名称
      actual: z.string(), // 实际的名称
    }),
  )

  // OpenCode 格式的技能文件搜索模式
  const OPENCODE_SKILL_GLOB = new Bun.Glob("{skill,skills}/**/SKILL.md")
  // Claude 格式的技能文件搜索模式
  const CLAUDE_SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")

  /**
   * 技能状态初始化
   *
   * 扫描并加载所有可用的技能文件
   */
  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}

    /**
     * 添加技能到注册表
     * 解析 SKILL.md 文件并提取元数据
     */
    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match)
      if (!md) {
        return
      }

      // 验证必需字段
      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // 警告重复的技能名称
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      // 注册技能
      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
      }
    }

    // 扫描 .claude/skills/ 目录（项目级别）
    const claudeDirs = await Array.fromAsync(
      Filesystem.up({
        targets: [".claude"], // 搜索 .claude 目录
        start: Instance.directory, // 从当前目录开始
        stop: Instance.worktree, // 到工作目录根停止
      }),
    )
    // 也包含全局 ~/.claude/skills/ 目录
    const globalClaude = `${Global.Path.home}/.claude`
    if (await exists(globalClaude)) {
      claudeDirs.push(globalClaude)
    }

    // 遍历 .claude 目录查找技能文件
    for (const dir of claudeDirs) {
      const matches = await Array.fromAsync(
        CLAUDE_SKILL_GLOB.scan({
          cwd: dir,
          absolute: true, // 返回绝对路径
          onlyFiles: true,
          followSymlinks: true, // 跟随符号链接
          dot: true, // 包含点开头的文件
        }),
      ).catch((error) => {
        log.error("failed .claude directory scan for skills", { dir, error })
        return []
      })

      for (const match of matches) {
        await addSkill(match)
      }
    }

    // 扫描 .opencode/skill/ 目录
    for (const dir of await Config.directories()) {
      for await (const match of OPENCODE_SKILL_GLOB.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match)
      }
    }

    return skills
  })

  /**
   * 获取指定名称的技能
   *
   * @param name - 技能名称
   * @returns 技能信息，不存在返回 undefined
   */
  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  /**
   * 获取所有可用技能
   *
   * @returns 技能信息数组
   */
  export async function all() {
    return state().then((x) => Object.values(x))
  }
}
