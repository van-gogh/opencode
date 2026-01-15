/**
 * Bash 工具 - 命令行执行
 *
 * 本工具允许 AI 在用户系统上执行 shell 命令。
 *
 * 主要功能：
 * - 执行任意 shell 命令
 * - 支持自定义工作目录
 * - 支持命令超时
 * - 实时输出流
 * - 权限控制
 *
 * 安全机制：
 * - 使用 tree-sitter 解析命令，提取执行的操作
 * - 对危险命令（rm, mv 等）请求用户确认
 * - 对项目目录外的操作请求权限
 *
 * @module tool/bash
 */

import z from "zod" // Schema 验证
import { spawn } from "child_process" // 进程创建
import { Tool } from "./tool" // 工具定义
import path from "path" // 路径处理
import DESCRIPTION from "./bash.txt" // 工具描述
import { Log } from "../util/log" // 日志
import { Instance } from "../project/instance" // 项目实例
import { lazy } from "@/util/lazy" // 延迟加载
import { Language } from "web-tree-sitter" // Tree-sitter 语言

import { $ } from "bun" // Bun shell
import { Filesystem } from "@/util/filesystem" // 文件系统工具
import { fileURLToPath } from "url" // URL 转换
import { Flag } from "@/flag/flag.ts" // 功能标志
import { Shell } from "@/shell/shell" // Shell 工具

import { BashArity } from "@/permission/arity" // 命令参数数量
import { Truncate } from "./truncation" // 输出截断

/**
 * 元数据最大长度
 * 防止巨大输出占用过多内存
 */
const MAX_METADATA_LENGTH = 30_000

/**
 * 默认超时时间（2 分钟）
 * 可通过环境变量覆盖
 */
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

// 创建 Bash 工具专用日志记录器
export const log = Log.create({ service: "bash-tool" })

/**
 * 解析 WASM 文件路径
 *
 * 处理不同格式的路径：file://, 绝对路径, 相对路径
 *
 * @param asset - 资源路径
 * @returns 解析后的文件系统路径
 */
const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

/**
 * 延迟加载的 Bash 解析器
 *
 * 使用 tree-sitter 解析 bash 命令，用于：
 * 1. 提取命令名和参数
 * 2. 检测危险操作
 * 3. 生成权限请求
 */
const parser = lazy(async () => {
  // 加载 tree-sitter 解析器
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })

  // 加载 Bash 语言语法
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)

  // 创建并配置解析器
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

/**
 * Bash 工具定义
 *
 * 提供命令行执行能力，包括：
 * - 命令解析和权限检查
 * - 超时和取消处理
 * - 实时输出流
 */
// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  // 检测可用的 shell
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    // 描述文本，替换模板变量
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),

    // 参数定义
    parameters: z.object({
      command: z.string().describe("The command to execute"), // 要执行的命令
      timeout: z.number().describe("Optional timeout in milliseconds").optional(), // 超时时间
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(), // 工作目录
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ), // 命令描述
    }),

    /**
     * 执行命令
     *
     * @param params - 命令参数
     * @param ctx - 工具上下文
     */
    async execute(params, ctx) {
      // 确定工作目录
      const cwd = params.workdir || Instance.directory

      // 验证超时参数
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT

      // 解析命令
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }

      // 收集需要权限的目录和命令模式
      const directories = new Set<string>()
      if (!Filesystem.contains(Instance.directory, cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      // 遍历命令语法树，提取命令和参数
      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue
        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          // 只提取命令名和参数节点
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // 检查文件系统操作命令，解析目标路径
        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            // 跳过选项参数
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            // 解析真实路径
            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              // Git Bash on Windows returns Unix-style paths like /c/Users/...
              // 处理 Windows 上 Git Bash 的路径格式
              const normalized =
                process.platform === "win32" && resolved.match(/^\/[a-z]\//)
                  ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
                  : resolved
              // 检查是否在项目目录外
              if (!Filesystem.contains(Instance.directory, normalized)) directories.add(normalized)
            }
          }
        }

        // 记录需要权限的命令模式
        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(command.join(" "))
          always.add(BashArity.prefix(command).join(" ") + "*")
        }
      }

      // 请求外部目录访问权限
      if (directories.size > 0) {
        await ctx.ask({
          permission: "external_directory",
          patterns: Array.from(directories),
          always: Array.from(directories).map((x) => path.dirname(x) + "*"),
          metadata: {},
        })
      }

      // 请求命令执行权限
      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      // 创建子进程执行命令
      const proc = spawn(params.command, {
        shell,
        cwd,
        env: {
          ...process.env,
        },
        stdio: ["ignore", "pipe", "pipe"], // 忽略 stdin，捕获 stdout 和 stderr
        detached: process.platform !== "win32", // 非 Windows 上分离进程组
      })

      let output = ""

      // 初始化元数据
      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      /**
       * 追加输出并更新元数据
       * @param chunk - 数据块
       */
      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            // 截断元数据以防止过大
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      // 监听 stdout 和 stderr
      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      // 状态标志
      let timedOut = false // 是否超时
      let aborted = false // 是否被取消
      let exited = false // 是否已退出

      // 终止进程树
      const kill = () => Shell.killTree(proc, { exited: () => exited })

      // 检查是否已经被取消
      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      // 取消处理器
      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      // 超时定时器
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100) // 额外 100ms 缓冲

      // 等待进程结束
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      // 构建结果元数据
      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      // 添加元数据到输出
      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      // 返回结果
      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode, // 退出码
          description: params.description,
        },
        output,
      }
    },
  }
})
