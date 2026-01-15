/**
 * Command 模块 - 命令系统
 *
 * 本模块提供命令（斜杠命令）管理功能，允许用户通过 /命令名 快捷执行预定义操作。
 * 
 * 主要功能：
 * - 内置命令：init（创建/更新 AGENTS.md）、review（代码审查）
 * - 自定义命令：通过配置文件定义
 * - MCP 命令：通过 MCP 协议插件提供的提示词模板
 *
 * 命令模板支持参数占位符：
 * - $1, $2, ... 等编号参数
 * - $ARGUMENTS 全部参数
 *
 * @module command
 */

import { BusEvent } from "@/bus/bus-event" // 事件定义
import z from "zod" // 参数验证
import { Config } from "../config/config" // 配置管理
import { Instance } from "../project/instance" // 项目实例
import { Identifier } from "../id/id" // ID 管理
import PROMPT_INITIALIZE from "./template/initialize.txt" // 初始化模板
import PROMPT_REVIEW from "./template/review.txt" // 审查模板
import { MCP } from "../mcp" // MCP 协议

/**
 * Command 命名空间
 *
 * 提供命令的注册、获取和列表接口
 */
export namespace Command {
  /**
   * 命令相关事件定义
   */
  export const Event = {
    /**
     * 命令执行事件
     * 当用户执行命令时触发
     */
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(), // 命令名称
        sessionID: Identifier.schema("session"), // 执行命令的会话 ID
        arguments: z.string(), // 命令参数
        messageID: Identifier.schema("message"), // 关联的消息 ID
      }),
    ),
  }

  /**
   * 命令信息 Schema
   *
   * 定义命令的元数据结构
   */
  export const Info = z
    .object({
      name: z.string(), // 命令名称，用于 /命令名 调用
      description: z.string().optional(), // 命令描述
      agent: z.string().optional(), // 指定使用的 Agent
      model: z.string().optional(), // 指定使用的模型
      mcp: z.boolean().optional(), // 是否来自 MCP 插件
      // 由于 Zod 不原生支持异步函数，使用 getter 作为解决方案
      // 参考: https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()), // 命令模板（同步或异步）
      subtask: z.boolean().optional(), // 是否为子任务模式
      hints: z.array(z.string()), // 参数提示列表
    })
    .meta({
      ref: "Command",
    })

  // 由于 Zod 将 z.promise(z.string()).or(z.string()) 推断为 string，需要手动覆盖类型
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  /**
   * 从模板中提取参数提示
   *
   * 解析模板字符串，查找 $1, $2 等编号参数和 $ARGUMENTS
   *
   * @param template - 命令模板字符串
   * @returns 参数提示数组
   */
  export function hints(template: string): string[] {
    const result: string[] = []
    // 匹配编号参数 $1, $2, ...
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      // 去重并排序
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    // 检查是否使用 $ARGUMENTS
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  /**
   * 内置默认命令名称
   */
  export const Default = {
    INIT: "init", // 初始化命令，创建/更新 AGENTS.md
    REVIEW: "review", // 审查命令，代码审查
  } as const

  /**
   * 命令状态初始化
   *
   * 加载内置命令、用户自定义命令和 MCP 提示词
   */
  const state = Instance.state(async () => {
    const cfg = await Config.get()

    // 初始化内置命令
    const result: Record<string, Info> = {
      // init 命令：创建或更新项目的 AGENTS.md 文件
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        get template() {
          // 将工作目录注入模板
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      // review 命令：代码审查，支持 commit/branch/pr
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true, // 使用子任务模式
        hints: hints(PROMPT_REVIEW),
      },
    }

    // 加载用户自定义命令
    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        agent: command.agent, // 用户指定的 Agent
        model: command.model, // 用户指定的模型
        description: command.description,
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }
    // 加载 MCP 插件提供的提示词作为命令
    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      result[name] = {
        name,
        mcp: true, // 标记为 MCP 命令
        description: prompt.description,
        get template() {
          // 由于 getter 不能是异步的，需要手动返回 Promise
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? // 将每个参数替换为 $1, $2 等占位符
                  Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            // 合并所有消息内容
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    return result
  })

  /**
   * 获取指定名称的命令
   *
   * @param name - 命令名称
   * @returns 命令信息，不存在返回 undefined
   */
  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  /**
   * 获取所有可用命令列表
   *
   * @returns 命令信息数组
   */
  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
