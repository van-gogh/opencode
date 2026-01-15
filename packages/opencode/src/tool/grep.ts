/**
 * GrepTool - 文本搜索工具
 *
 * 本工具使用正则表达式搜索文件内容，基于 ripgrep 实现快速全文搜索。
 * 
 * 主要功能：
 * - 支持正则表达式模式
 * - 显示匹配行号和内容
 * - 按文件修改时间排序
 * - 支持文件类型过滤
 *
 * 使用场景：
 * - 搜索代码中的特定模式
 * - 查找函数/变量引用
 * - 定位错误消息
 *
 * @module tool/grep
 */

import z from "zod" // 参数验证
import { Tool } from "./tool" // 工具基础类
import { Ripgrep } from "../file/ripgrep" // ripgrep 封装

import DESCRIPTION from "./grep.txt" // 工具描述
import { Instance } from "../project/instance" // 项目实例

// 单行最大长度限制，避免输出过长
const MAX_LINE_LENGTH = 2000

/**
 * 定义文本搜索工具
 */
export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"), // 正则模式
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."), // 搜索目录
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'), // 文件类型过滤
  }),
  /**
   * 执行文本搜索
   */
  async execute(params, ctx) {
    // 验证必填参数
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    // 请求权限
    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    const searchPath = params.path || Instance.directory

    // 构建 ripgrep 命令参数
    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--field-match-separator=|", "--regexp", params.pattern]
    // -n: 显示行号
    // -H: 显示文件名
    // --field-match-separator: 使用 | 分隔字段
    if (params.include) {
      args.push("--glob", params.include) // 添加文件类型过滤
    }
    args.push(searchPath)

    // 执行 ripgrep
    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })

    // 获取输出和错误
    const output = await new Response(proc.stdout).text()
    const errorOutput = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    // 退出码 1 表示未找到匹配
    if (exitCode === 1) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    // 其他非零退出码表示错误
    if (exitCode !== 0) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    // 解析搜索结果（支持 Unix 和 Windows 行尾）
    const lines = output.trim().split(/\r?\n/)
    const matches = []

    // 解析每行结果
    for (const line of lines) {
      if (!line) continue

      // 解析格式：文件路径|行号|内容
      const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
      if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

      const lineNum = parseInt(lineNumStr, 10)
      const lineText = lineTextParts.join("|") // 重新组合可能包含 | 的内容

      // 获取文件修改时间
      const file = Bun.file(filePath)
      const stats = await file.stat().catch(() => null)
      if (!stats) continue

      matches.push({
        path: filePath,
        modTime: stats.mtime.getTime(),
        lineNum,
        lineText,
      })
    }

    // 按修改时间排序，最新的在前
    matches.sort((a, b) => b.modTime - a.modTime)

    // 限制结果数量
    const limit = 100
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    // 未找到匹配
    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    // 生成输出
    const outputLines = [`Found ${finalMatches.length} matches`]

    // 按文件分组输出
    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("") // 文件之间空行
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`) // 文件路径标题
      }
      // 截断过长的行
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    // 添加截断提示
    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    return {
      title: params.pattern, // 搜索模式作为标题
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
