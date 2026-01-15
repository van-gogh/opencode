/**
 * OpenCode CLI 应用程序入口文件
 *
 * 本文件是整个 OpenCode CLI 应用程序的主入口点。
 * OpenCode 是一个基于 AI 的代码编辑和开发辅助工具，
 * 提供了会话管理、AI Agent、代码编辑、MCP 集成等功能。
 *
 * 主要功能模块：
 * - CLI 命令处理（使用 yargs 库）
 * - 日志系统初始化
 * - 各种子命令注册（run, auth, agent, serve 等）
 * - 全局错误处理
 *
 * @module index
 * @author OpenCode Team
 */

// yargs: 强大的命令行参数解析库
import yargs from "yargs"
// hideBin: 用于处理命令行参数，移除 node 执行路径等无关参数
import { hideBin } from "yargs/helpers"

// ============ CLI 命令模块导入 ============
// 每个命令模块负责处理特定的 CLI 子命令

import { RunCommand } from "./cli/cmd/run" // run 命令：运行 OpenCode 主程序
import { GenerateCommand } from "./cli/cmd/generate" // generate 命令：生成代码或配置
import { Log } from "./util/log" // 日志工具类
import { AuthCommand } from "./cli/cmd/auth" // auth 命令：处理认证相关操作
import { AgentCommand } from "./cli/cmd/agent" // agent 命令：Agent 管理
import { UpgradeCommand } from "./cli/cmd/upgrade" // upgrade 命令：升级 OpenCode
import { UninstallCommand } from "./cli/cmd/uninstall" // uninstall 命令：卸载 OpenCode
import { ModelsCommand } from "./cli/cmd/models" // models 命令：列出可用模型
import { UI } from "./cli/ui" // UI 工具，用于终端输出美化
import { Installation } from "./installation" // 安装信息管理
import { NamedError } from "@opencode-ai/util/error" // 命名错误类
import { FormatError } from "./cli/error" // 错误格式化工具
import { ServeCommand } from "./cli/cmd/serve" // serve 命令：启动服务器模式
import { DebugCommand } from "./cli/cmd/debug" // debug 命令：调试模式
import { StatsCommand } from "./cli/cmd/stats" // stats 命令：显示统计信息
import { McpCommand } from "./cli/cmd/mcp" // mcp 命令：MCP（Model Context Protocol）相关
import { GithubCommand } from "./cli/cmd/github" // github 命令：GitHub 集成
import { ExportCommand } from "./cli/cmd/export" // export 命令：导出会话或数据
import { ImportCommand } from "./cli/cmd/import" // import 命令：导入会话或数据
import { AttachCommand } from "./cli/cmd/tui/attach" // attach 命令：附加到现有会话
import { TuiThreadCommand } from "./cli/cmd/tui/thread" // thread 命令：TUI 线程管理
import { TuiSpawnCommand } from "./cli/cmd/tui/spawn" // spawn 命令：TUI 进程生成
import { AcpCommand } from "./cli/cmd/acp" // acp 命令：ACP（Agent Communication Protocol）
import { EOL } from "os" // 操作系统特定的换行符
import { WebCommand } from "./cli/cmd/web" // web 命令：Web 界面相关
import { PrCommand } from "./cli/cmd/pr" // pr 命令：Pull Request 相关
import { SessionCommand } from "./cli/cmd/session" // session 命令：会话管理

// ============ 全局错误处理器 ============
// 这些处理器确保未捕获的错误不会导致程序静默失败

/**
 * 处理未捕获的 Promise 拒绝
 * 当 Promise 被拒绝但没有 catch 处理时触发
 */
process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

/**
 * 处理未捕获的同步异常
 * 当抛出异常但没有 try-catch 捕获时触发
 */
process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// ============ CLI 配置与命令注册 ============

/**
 * 创建并配置 CLI 实例
 *
 * yargs 是一个功能强大的命令行解析器，这里配置了：
 * 1. 基本设置（脚本名、帮助信息、版本号）
 * 2. 全局选项（日志级别等）
 * 3. 中间件（日志初始化）
 * 4. 所有子命令
 * 5. 错误处理
 */
const cli = yargs(hideBin(process.argv))
  // 启用 "--" 后的参数收集，允许传递参数给子进程
  .parserConfiguration({ "populate--": true })
  // 设置脚本名称，显示在帮助信息中
  .scriptName("opencode")
  // 设置输出宽度为 100 字符
  .wrap(100)
  // 配置帮助选项
  .help("help", "show help")
  .alias("help", "h")
  // 配置版本选项，从 Installation 模块获取版本号
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  // 全局选项：是否将日志打印到 stderr
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  // 全局选项：日志级别
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  /**
   * 中间件：在执行任何命令之前运行
   * 负责初始化日志系统和设置环境变量
   */
  .middleware(async (opts) => {
    // 初始化日志系统
    await Log.init({
      print: process.argv.includes("--print-logs"), // 是否打印到控制台
      dev: Installation.isLocal(), // 是否为本地开发模式
      level: (() => {
        // 确定日志级别优先级：命令行参数 > 开发模式默认 > 生产默认
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    // 设置环境变量，标记当前运行在 OpenCode Agent 环境中
    process.env.AGENT = "1"
    process.env.OPENCODE = "1"

    // 记录启动日志
    Log.Default.info("opencode", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
  })
  // 显示 Logo 作为使用说明的一部分
  .usage("\n" + UI.logo())
  // 生成 shell 补全脚本的命令
  .completion("completion", "generate shell completion script")
  // ============ 注册所有子命令 ============
  // 协议相关命令
  .command(AcpCommand) // Agent Communication Protocol
  .command(McpCommand) // Model Context Protocol
  // TUI（终端用户界面）相关命令
  .command(TuiThreadCommand) // 线程管理
  .command(TuiSpawnCommand) // 进程生成
  .command(AttachCommand) // 附加到现有会话
  // 核心功能命令
  .command(RunCommand) // 运行主程序（默认命令）
  .command(GenerateCommand) // 代码生成
  .command(DebugCommand) // 调试模式
  // 认证与用户管理
  .command(AuthCommand) // 认证管理
  .command(AgentCommand) // Agent 配置管理
  // 安装与更新
  .command(UpgradeCommand) // 升级
  .command(UninstallCommand) // 卸载
  // 服务与界面
  .command(ServeCommand) // 启动服务器
  .command(WebCommand) // Web 界面
  // 模型与统计
  .command(ModelsCommand) // 模型列表
  .command(StatsCommand) // 统计信息
  // 数据导入导出
  .command(ExportCommand) // 导出
  .command(ImportCommand) // 导入
  // 版本控制集成
  .command(GithubCommand) // GitHub 集成
  .command(PrCommand) // Pull Request
  .command(SessionCommand) // 会话管理
  /**
   * 错误处理回调
   * 当参数解析失败时，显示帮助信息并退出
   */
  .fail((msg) => {
    if (
      msg.startsWith("Unknown argument") ||
      msg.startsWith("Not enough non-option arguments") ||
      msg.startsWith("Invalid values:")
    ) {
      cli.showHelp("log")
    }
    process.exit(1)
  })
  // 启用严格模式：未知参数会报错
  .strict()

// ============ 主程序入口 ============

/**
 * 解析并执行 CLI 命令
 *
 * 使用 try-catch-finally 结构确保：
 * 1. 正常执行时运行相应命令
 * 2. 出错时正确记录和显示错误信息
 * 3. 无论成功失败都正确退出进程
 */
try {
  // 解析命令行参数并执行对应的命令处理器
  await cli.parse()
} catch (e) {
  // 收集错误详情用于日志记录
  let data: Record<string, any> = {}

  // 处理 NamedError（OpenCode 自定义的带名称的错误类型）
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  // 处理标准 Error 对象
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  // 处理 Bun 的 ResolveMessage（模块解析错误）
  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier, // 尝试解析的模块标识符
      referrer: e.referrer, // 发起导入的文件
      position: e.position, // 错误位置
      importKind: e.importKind, // 导入类型
    })
  }

  // 记录致命错误到日志文件
  Log.Default.error("fatal", data)

  // 格式化并显示错误信息给用户
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)

  // 如果无法格式化错误（未知错误类型），显示通用错误信息
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e)
  }

  // 设置非零退出码表示失败
  process.exitCode = 1
} finally {
  /**
   * 显式退出进程
   *
   * 某些子进程（特别是基于 Docker 容器的 MCP 服务器）不能正确响应
   * SIGTERM 等信号，除非使用 `docker run --init` 运行。
   * 显式调用 exit() 确保不会有子进程挂起。
   */
  process.exit()
}
