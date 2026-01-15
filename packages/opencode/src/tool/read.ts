/**
 * Read 工具 - 文件读取
 *
 * 本工具允许 AI 读取文件内容，支持多种文件类型。
 *
 * 主要功能：
 * - 读取文本文件（带行号）
 * - 支持分页读取大文件
 * - 读取图片和 PDF 作为附件
 * - 自动检测二进制文件
 * - 文件不存在时提供建议
 *
 * 输出限制：
 * - 默认 2000 行
 * - 单行最大 2000 字符
 * - 最大 50KB 字节
 *
 * @module tool/read
 */

import z from "zod" // Schema 验证
import * as fs from "fs" // 文件系统
import * as path from "path" // 路径处理
import { Tool } from "./tool" // 工具定义
import { LSP } from "../lsp" // LSP 集成
import { FileTime } from "../file/time" // 文件时间跟踪
import DESCRIPTION from "./read.txt" // 工具描述
import { Filesystem } from "../util/filesystem" // 文件系统工具
import { Instance } from "../project/instance" // 项目实例
import { Identifier } from "../id/id" // ID 生成

/** 默认读取行数限制 */
const DEFAULT_READ_LIMIT = 2000
/** 单行最大字符数 */
const MAX_LINE_LENGTH = 2000
/** 最大读取字节数 */
const MAX_BYTES = 50 * 1024

/**
 * Read 工具定义
 *
 * 提供文件读取能力，支持分页和多种文件格式
 */
export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,

  // 参数定义
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"), // 文件路径
    offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(), // 起始行
    limit: z.coerce.number().describe("The number of lines to read (defaults to 2000)").optional(), // 行数限制
  }),

  /**
   * 执行文件读取
   *
   * @param params - 读取参数
   * @param ctx - 工具上下文
   */
  async execute(params, ctx) {
    // 解析文件路径
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(process.cwd(), filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    // 检查外部目录访问权限
    if (!ctx.extra?.["bypassCwdCheck"] && !Filesystem.contains(Instance.directory, filepath)) {
      const parentDir = path.dirname(filepath)
      await ctx.ask({
        permission: "external_directory",
        patterns: [parentDir],
        always: [parentDir + "/*"],
        metadata: {
          filepath,
          parentDir,
        },
      })
    }

    // 请求读取权限
    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    // 检查文件是否存在
    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      // 文件不存在，提供建议
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error("File not found: " + filepath + "\n\nDid you mean one of these?\n" + suggestions.join("\n"))
      }

      throw new Error(`File not found: ${filepath}`)
    }

    // 处理图片和 PDF 文件
    const isImage = file.type.startsWith("image/") && file.type !== "image/svg+xml"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const mime = file.type
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      // 返回文件作为附件
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    // 检查是否为二进制文件
    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    // 读取文本文件
    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0
    const lines = await file.text().then((text) => text.split("\n"))

    // 收集指定范围的行
    const raw: string[] = []
    let bytes = 0
    let truncatedByBytes = false
    for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
      // 截断过长的行
      const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + "..." : lines[i]
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      // 检查字节限制
      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true
        break
      }
      raw.push(line)
      bytes += size
    }

    // 添加行号
    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    // 构建输出
    let output = "<file>\n"
    output += content.join("\n")

    // 计算截断信息
    const totalLines = lines.length
    const lastReadLine = offset + raw.length
    const hasMoreLines = totalLines > lastReadLine
    const truncated = hasMoreLines || truncatedByBytes

    // 添加截断提示
    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // 预热 LSP 客户端
    // just warms the lsp client
    LSP.touchFile(filepath, false)
    // 记录文件读取时间
    FileTime.read(ctx.sessionID, filepath)

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
      },
    }
  },
})

/**
 * 检测文件是否为二进制文件
 *
 * 检测方法：
 * 1. 根据扩展名判断常见二进制格式
 * 2. 检测文件前 4KB 中的不可打印字符比例
 *
 * @param filepath - 文件路径
 * @param file - Bun 文件对象
 * @returns 是否为二进制文件
 */
async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()

  // 根据扩展名判断常见二进制格式
  // binary check for common non-text extensions
  switch (ext) {
    // 压缩文件
    case ".zip":
    case ".tar":
    case ".gz":
    case ".7z":
    // 可执行文件
    case ".exe":
    case ".dll":
    case ".so":
    // Java 类
    case ".class":
    case ".jar":
    case ".war":
    // Office 文档
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    // 其他二进制
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  // 通过内容检测
  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  // 读取文件前 4KB
  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer.slice(0, bufferSize))

  // 统计不可打印字符
  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    // NULL 字节直接判定为二进制
    if (bytes[i] === 0) return true
    // 控制字符（除 tab, 换行, 回车）
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  // 如果超过 30% 的不可打印字符，判定为二进制
  return nonPrintableCount / bytes.length > 0.3
}
