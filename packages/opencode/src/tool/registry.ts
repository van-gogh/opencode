/**
 * 工具注册表模块 - Tool Registry Module
 *
 * 本模块负责管理所有可用的工具，包括：
 * - 内置工具（bash, read, write, edit, grep 等）
 * - 插件工具（从配置目录或插件加载）
 * - 实验性工具（LSP, batch 等）
 *
 * 工作流程：
 * 1. 系统启动时加载所有内置工具
 * 2. 扫描配置目录下的自定义工具
 * 3. 加载插件定义的工具
 * 4. 根据 Agent 权限过滤可用工具
 *
 * @module tool/registry
 */

// ============ 内置工具导入 ============
import { QuestionTool } from "./question" // 用户问题工具：向用户提问
import { BashTool } from "./bash" // Bash 命令执行工具
import { EditTool } from "./edit" // 文件编辑工具
import { GlobTool } from "./glob" // 文件模式匹配工具
import { GrepTool } from "./grep" // 内容搜索工具
import { BatchTool } from "./batch" // 批量操作工具（实验性）
import { ReadTool } from "./read" // 文件读取工具
import { TaskTool } from "./task" // 子任务工具
import { TodoWriteTool, TodoReadTool } from "./todo" // 任务列表读写工具
import { WebFetchTool } from "./webfetch" // 网页获取工具
import { WriteTool } from "./write" // 文件写入工具
import { InvalidTool } from "./invalid" // 无效工具占位符
import { SkillTool } from "./skill" // 技能工具
import type { Agent } from "../agent/agent" // Agent 类型
import { Tool } from "./tool" // 工具基础类型
import { Instance } from "../project/instance" // 项目实例
import { Config } from "../config/config" // 配置管理
import path from "path" // 路径处理
import { type ToolDefinition } from "@opencode-ai/plugin" // 插件工具定义类型
import z from "zod" // 参数验证
import { Plugin } from "../plugin" // 插件系统
import { WebSearchTool } from "./websearch" // 网络搜索工具
import { CodeSearchTool } from "./codesearch" // 代码搜索工具
import { Flag } from "@/flag/flag" // 功能标志
import { Log } from "@/util/log" // 日志工具
import { LspTool } from "./lsp" // LSP 工具（实验性）
import { Truncate } from "./truncation" // 输出截断工具

/**
 * 工具注册表命名空间
 *
 * 提供工具的注册、查询和初始化功能
 */
export namespace ToolRegistry {
  // 创建工具注册表专用的日志记录器
  const log = Log.create({ service: "tool.registry" })

  /**
   * 工具注册表状态
   *
   * 使用 Instance.state 创建一个项目级别的单例状态
   * 包含所有自定义/插件工具的列表
   *
   * 初始化过程：
   * 1. 扫描所有配置目录下的 tool/*.{js,ts} 文件
   * 2. 加载所有已安装插件的工具定义
   */
  export const state = Instance.state(async () => {
    // 存储自定义工具的数组
    const custom = [] as Tool.Info[]

    // 创建 glob 模式用于匹配工具文件
    const glob = new Bun.Glob("tool/*.{js,ts}")

    // 遍历所有配置目录（如 ~/.config/opencode, .opencode 等）
    for (const dir of await Config.directories()) {
      // 扫描目录下的工具文件
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true, // 返回绝对路径
        followSymlinks: true, // 跟随符号链接
        dot: true, // 包含隐藏文件
      })) {
        // 从文件路径提取命名空间
        const namespace = path.basename(match, path.extname(match))
        // 动态导入工具模块
        const mod = await import(match)
        // 遍历模块导出，注册每个工具
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          // 如果是默认导出，使用文件名作为 ID；否则使用 “文件名_导出名”
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
        }
      }
    }

    // 加载插件定义的工具
    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  /**
   * 将插件工具定义转换为内部工具格式
   *
   * 插件工具使用简化的定义格式，需要转换为 Tool.Info 格式
   *
   * @param id - 工具唯一标识符
   * @param def - 插件工具定义
   * @returns 转换后的工具对象
   */
  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args), // 将参数定义转换为 Zod 对象模式
        description: def.description,
        execute: async (args, ctx) => {
          // 执行插件工具
          const result = await def.execute(args as any, ctx)
          // 处理输出截断
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  /**
   * 注册新工具
   *
   * 如果工具已存在（相同 ID），则替换原有工具
   * 否则添加到工具列表末尾
   *
   * @param tool - 要注册的工具
   */
  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      // 替换现有工具
      custom.splice(idx, 1, tool)
      return
    }
    // 添加新工具
    custom.push(tool)
  }

  /**
   * 获取所有可用工具（内部方法）
   *
   * 返回包含所有内置工具和自定义工具的列表
   * 某些工具可能根据配置或功能标志有条件地启用
   *
   * @returns 所有可用工具的数组
   */
  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const config = await Config.get()

    return [
      // 无效工具占位符，用于处理无效的工具调用
      InvalidTool,
      // 问题工具仅在 CLI 模式下可用（TUI 中不需要）
      ...(Flag.OPENCODE_CLIENT === "cli" ? [QuestionTool] : []),
      // 核心内置工具
      BashTool, // 执行 shell 命令
      ReadTool, // 读取文件内容
      GlobTool, // 文件模式匹配
      GrepTool, // 内容搜索
      EditTool, // 编辑文件
      WriteTool, // 写入文件
      TaskTool, // 创建子任务
      WebFetchTool, // 获取网页内容
      TodoWriteTool, // 写入任务列表
      TodoReadTool, // 读取任务列表
      WebSearchTool, // 网络搜索
      CodeSearchTool, // 代码搜索
      SkillTool, // 技能工具
      // 实验性 LSP 工具（需要功能标志启用）
      ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      // 实验性批量工具（需要配置启用）
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      // 所有自定义/插件工具
      ...custom,
    ]
  }

  /**
   * 获取所有工具 ID 列表
   *
   * @returns 工具 ID 字符串数组
   */
  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  /**
   * 获取特定 Provider 和 Agent 可用的工具列表
   *
   * 该方法会：
   * 1. 获取所有工具
   * 2. 根据 Provider 过滤某些工具（如 websearch/codesearch 需要特定条件）
   * 3. 初始化每个工具并返回完整信息
   *
   * @param providerID - 当前使用的 Provider ID
   * @param agent - 当前 Agent 信息（可选）
   * @returns 初始化后的工具列表
   */
  export async function tools(providerID: string, agent?: Agent.Info) {
    const tools = await all()
    const result = await Promise.all(
      tools
        .filter((t) => {
          // websearch/codesearch 工具需要特定条件：
          // - 使用 opencode Provider（Zen 用户）
          // - 或启用了 Exa 功能标志
          if (t.id === "codesearch" || t.id === "websearch") {
            return providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
          }
          return true
        })
        .map(async (t) => {
          // 使用日志计时器记录工具初始化时间
          using _ = log.time(t.id)
          return {
            id: t.id,
            ...(await t.init({ agent })),
          }
        }),
    )
    return result
  }
}
