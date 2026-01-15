/**
 * 工具模块 - Tool Module
 *
 * 本模块定义了 OpenCode 工具系统的核心类型和工具工厂函数。
 * 工具是 AI Agent 与外部世界交互的主要方式，包括：
 * - 文件读写（read, write, edit）
 * - 命令执行（bash）
 * - 代码搜索（grep, glob, codesearch）
 * - 网络请求（webfetch, websearch）
 * - 等等...
 *
 * 每个工具都有：
 * - 唯一标识符 (id)
 * - 描述和参数 schema
 * - 执行函数 (execute)
 *
 * @module tool
 */

import z from "zod" // Zod: TypeScript 优先的模式验证库
import type { MessageV2 } from "../session/message-v2" // 消息类型定义
import type { Agent } from "../agent/agent" // Agent 类型定义
import type { PermissionNext } from "../permission/next" // 权限系统类型
import { Truncate } from "./truncation" // 输出截断工具

/**
 * Tool 命名空间
 *
 * 包含工具系统的所有类型定义和工具创建函数
 */
export namespace Tool {
  /**
   * 元数据接口
   * 工具执行结果的附加信息，可以包含任意键值对
   */
  interface Metadata {
    [key: string]: any
  }

  /**
   * 工具初始化上下文
   * 在工具初始化时传入，包含 Agent 信息
   */
  export interface InitContext {
    agent?: Agent.Info // 当前执行工具的 Agent 信息
  }

  /**
   * 工具执行上下文
   *
   * 在工具的 execute 方法中传入，提供执行所需的所有信息
   *
   * @template M - 元数据类型
   */
  export type Context<M extends Metadata = Metadata> = {
    sessionID: string // 当前会话 ID
    messageID: string // 当前消息 ID
    agent: string // 当前 Agent 名称
    abort: AbortSignal // 用于取消操作的信号
    callID?: string // 工具调用 ID（可选）
    extra?: { [key: string]: any } // 额外数据（可选）
    /**
     * 更新工具执行的元数据
     * @param input - 包含标题和元数据的对象
     */
    metadata(input: { title?: string; metadata?: M }): void
    /**
     * 请求用户授权
     * 用于需要用户确认的操作（如写文件、执行命令等）
     * @param input - 权限请求对象（不包含 id、sessionID、tool 字段）
     */
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
  }

  /**
   * 工具信息接口
   *
   * 定义了一个工具的完整结构：
   * - id: 工具的唯一标识符
   * - init: 初始化函数，返回工具的描述、参数和执行函数
   *
   * @template Parameters - 参数的 Zod 模式类型
   * @template M - 元数据类型
   */
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string // 工具唯一标识符
    /**
     * 工具初始化函数
     *
     * 返回工具的完整定义，包括：
     * - description: 工具描述，用于向 AI 解释工具用途
     * - parameters: Zod 模式，定义工具参数
     * - execute: 执行函数
     * - formatValidationError: 可选的验证错误格式化函数
     */
    init: (ctx?: InitContext) => Promise<{
      description: string // 工具描述
      parameters: Parameters // 参数 Zod 模式
      /**
       * 工具执行函数
       *
       * @param args - 经过验证的参数
       * @param ctx - 执行上下文
       * @returns 执行结果，包含标题、元数据、输出和可选的附件
       */
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string // 执行结果标题
        metadata: M // 元数据
        output: string // 文本输出
        attachments?: MessageV2.FilePart[] // 可选的文件附件
      }>
      /**
       * 可选的参数验证错误格式化函数
       * 用于自定义验证错误的显示方式
       */
      formatValidationError?(error: z.ZodError): string
    }>
  }

  /**
   * 工具类型辅助 - 推断工具参数类型
   * @template T - 工具信息类型
   */
  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never

  /**
   * 工具类型辅助 - 推断工具元数据类型
   * @template T - 工具信息类型
   */
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

  /**
   * 工具定义工厂函数
   *
   * 创建一个新工具，并自动包装以下功能：
   * 1. 参数验证：使用 Zod 模式验证输入参数
   * 2. 错误处理：参数验证失败时返回可读的错误信息
   * 3. 输出截断：自动截断过长的输出以防止占用过多 token
   *
   * @param id - 工具唯一标识符
   * @param init - 初始化函数或工具配置对象
   * @returns 完整的工具对象
   *
   * @example
   * ```typescript
   * const MyTool = Tool.define("my-tool", {
   *   description: "我的工具",
   *   parameters: z.object({
   *     input: z.string(),
   *   }),
   *   async execute(args, ctx) {
   *     return {
   *       title: "执行完成",
   *       metadata: {},
   *       output: `结果: ${args.input}`,
   *     }
   *   },
   * })
   * ```
   */
  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
  ): Info<Parameters, Result> {
    return {
      id,
      init: async (initCtx) => {
        // 如果 init 是函数则调用它，否则直接使用配置对象
        const toolInfo = init instanceof Function ? await init(initCtx) : init
        const execute = toolInfo.execute

        // 包装 execute 函数，添加参数验证和输出截断
        toolInfo.execute = async (args, ctx) => {
          // 参数验证
          try {
            toolInfo.parameters.parse(args)
          } catch (error) {
            // 如果提供了自定义错误格式化函数，使用它
            if (error instanceof z.ZodError && toolInfo.formatValidationError) {
              throw new Error(toolInfo.formatValidationError(error), { cause: error })
            }
            // 否则使用默认的错误消息
            throw new Error(
              `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
              { cause: error },
            )
          }

          // 执行工具
          const result = await execute(args, ctx)

          // 如果工具已经自行处理了截断，直接返回结果
          if (result.metadata.truncated !== undefined) {
            return result
          }

          // 否则自动截断过长的输出
          const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated, // 标记是否被截断
              ...(truncated.truncated && { outputPath: truncated.outputPath }), // 如果被截断，提供完整输出的文件路径
            },
          }
        }
        return toolInfo
      },
    }
  }
}
