/**
 * GlobTool - 文件匹配工具
 *
 * 本工具使用 glob 模式搜索文件，基于 ripgrep 实现快速文件查找。
 * 
 * 主要功能：
 * - 支持标准 glob 模式（*, **, ?, [] 等）
 * - 按修改时间排序结果
 * - 限制结果数量（最多 100 个）
 *
 * 使用场景：
 * - 查找特定类型的文件（如 *.ts, *.json）
 * - 搜索目录结构
 * - 快速定位文件
 *
 * @module tool/glob
 */

import z from "zod" // 参数验证
import path from "path" // 路径处理
import { Tool } from "./tool" // 工具基础类
import DESCRIPTION from "./glob.txt" // 工具描述
import { Ripgrep } from "../file/ripgrep" // ripgrep 封装
import { Instance } from "../project/instance" // 项目实例

/**
 * 定义文件匹配工具
 */
export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"), // glob 模式
    path: z
      .string()
      .optional()
      .describe(
        // 搜索目录（可选）
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  /**
   * 执行文件匹配
   */
  async execute(params, ctx) {
    // 请求权限
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    // 解析搜索路径
    let search = params.path ?? Instance.directory
    search = path.isAbsolute(search) ? search : path.resolve(Instance.directory, search)

    const limit = 100 // 结果数量限制
    const files = []
    let truncated = false

    // 使用 ripgrep 搜索匹配文件
    for await (const file of Ripgrep.files({
      cwd: search,
      glob: [params.pattern],
    })) {
      if (files.length >= limit) {
        truncated = true // 标记结果被截断
        break
      }
      // 获取文件的完整路径和修改时间
      const full = path.resolve(search, file)
      const stats = await Bun.file(full)
        .stat()
        .then((x) => x.mtime.getTime())
        .catch(() => 0)
      files.push({
        path: full,
        mtime: stats,
      })
    }
    // 按修改时间排序，最新的在前
    files.sort((a, b) => b.mtime - a.mtime)

    // 生成输出
    const output = []
    if (files.length === 0) output.push("No files found") // 未找到文件
    if (files.length > 0) {
      output.push(...files.map((f) => f.path))
      if (truncated) {
        output.push("")
        output.push("(Results are truncated. Consider using a more specific path or pattern.)") // 结果被截断提示
      }
    }

    return {
      title: path.relative(Instance.worktree, search), // 相对路径作为标题
      metadata: {
        count: files.length,
        truncated,
      },
      output: output.join("\n"),
    }
  },
})
