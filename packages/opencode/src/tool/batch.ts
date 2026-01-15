/**
 * BatchTool - 批量工具执行
 *
 * 本工具允许 AI 并行执行多个工具调用，提高效率。
 * 
 * 主要功能：
 * - 并行执行：最多 10 个工具同时执行
 * - 错误隔离：单个工具失败不影响其他工具
 * - 进度跟踪：每个工具调用都记录为独立的 Part
 *
 * 限制：
 * - 不能嵌套 batch（禁止在 batch 中调用 batch）
 * - 不能调用外部工具（MCP、环境工具）
 * - 最多 10 个工具调用
 *
 * @module tool/batch
 */

import z from "zod" // 参数验证
import { Tool } from "./tool" // 工具基础类
import DESCRIPTION from "./batch.txt" // 工具描述

// 禁止在 batch 中调用的工具
const DISALLOWED = new Set(["batch"])
// 从建议列表中过滤的工具
const FILTERED_FROM_SUGGESTIONS = new Set(["invalid", "patch", ...DISALLOWED])

/**
 * 定义批量执行工具
 */
export const BatchTool = Tool.define("batch", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      tool_calls: z
        .array(
          z.object({
            tool: z.string().describe("The name of the tool to execute"), // 工具名称
            parameters: z.object({}).loose().describe("Parameters for the tool"), // 工具参数
          }),
        )
        .min(1, "Provide at least one tool call") // 至少一个工具调用
        .describe("Array of tool calls to execute in parallel"), // 并行执行的工具调用数组
    }),
    /**
     * 格式化验证错误
     */
    formatValidationError(error) {
      const formattedErrors = error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "root"
          return `  - ${path}: ${issue.message}`
        })
        .join("\n")

      return `Invalid parameters for tool 'batch':
${formattedErrors}

Expected payload format:
  [{"tool": "tool_name", "parameters": {...}}, {...}]`
    },
    /**
     * 执行批量工具调用
     */
    async execute(params, ctx) {
      const { Session } = await import("../session")
      const { Identifier } = await import("../id/id")

      // 限制最多 10 个工具调用
      const toolCalls = params.tool_calls.slice(0, 10)
      const discardedCalls = params.tool_calls.slice(10) // 超出限制的调用

      // 获取可用工具注册表
      const { ToolRegistry } = await import("./registry")
      const availableTools = await ToolRegistry.tools("")
      const toolMap = new Map(availableTools.map((t) => [t.id, t]))

      /**
       * 执行单个工具调用
       * 包含验证、进度更新和错误处理
       */
      const executeCall = async (call: (typeof toolCalls)[0]) => {
        const callStartTime = Date.now()
        const partID = Identifier.ascending("part") // 生成唯一的 Part ID

        try {
          // 检查工具是否允许在 batch 中调用
          if (DISALLOWED.has(call.tool)) {
            throw new Error(
              `Tool '${call.tool}' is not allowed in batch. Disallowed tools: ${Array.from(DISALLOWED).join(", ")}`,
            )
          }

          // 检查工具是否存在于注册表
          const tool = toolMap.get(call.tool)
          if (!tool) {
            const availableToolsList = Array.from(toolMap.keys()).filter((name) => !FILTERED_FROM_SUGGESTIONS.has(name))
            throw new Error(
              `Tool '${call.tool}' not in registry. External tools (MCP, environment) cannot be batched - call them directly. Available tools: ${availableToolsList.join(", ")}`,
            )
          }
          // 验证工具参数
          const validatedParams = tool.parameters.parse(call.parameters)

          // 记录工具开始执行状态
          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: call.tool,
            callID: partID,
            state: {
              status: "running",
              input: call.parameters,
              time: {
                start: callStartTime,
              },
            },
          })

          // 执行工具
          const result = await tool.execute(validatedParams, { ...ctx, callID: partID })

          // 记录工具完成状态
          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: call.tool,
            callID: partID,
            state: {
              status: "completed",
              input: call.parameters,
              output: result.output,
              title: result.title,
              metadata: result.metadata,
              attachments: result.attachments,
              time: {
                start: callStartTime,
                end: Date.now(),
              },
            },
          })

          return { success: true as const, tool: call.tool, result }
        } catch (error) {
          // 记录工具执行失败状态
          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: call.tool,
            callID: partID,
            state: {
              status: "error",
              input: call.parameters,
              error: error instanceof Error ? error.message : String(error),
              time: {
                start: callStartTime,
                end: Date.now(),
              },
            },
          })

          return { success: false as const, tool: call.tool, error }
        }
      }

      // 并行执行所有工具调用
      const results = await Promise.all(toolCalls.map((call) => executeCall(call)))

      // 将超出限制的调用记录为错误
      const now = Date.now()
      for (const call of discardedCalls) {
        const partID = Identifier.ascending("part")
        await Session.updatePart({
          id: partID,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: call.tool,
          callID: partID,
          state: {
            status: "error",
            input: call.parameters,
            error: "Maximum of 10 tools allowed in batch",
            time: { start: now, end: now },
          },
        })
        results.push({
          success: false as const,
          tool: call.tool,
          error: new Error("Maximum of 10 tools allowed in batch"),
        })
      }

      // 统计执行结果
      const successfulCalls = results.filter((r) => r.success).length
      const failedCalls = results.length - successfulCalls

      // 生成输出消息
      const outputMessage =
        failedCalls > 0
          ? `Executed ${successfulCalls}/${results.length} tools successfully. ${failedCalls} failed.`
          : `All ${successfulCalls} tools executed successfully.\n\nKeep using the batch tool for optimal performance in your next response!`

      // 返回执行结果摘要
      return {
        title: `Batch execution (${successfulCalls}/${results.length} successful)`,
        output: outputMessage,
        attachments: results.filter((result) => result.success).flatMap((r) => r.result.attachments ?? []),
        metadata: {
          totalCalls: results.length,
          successful: successfulCalls,
          failed: failedCalls,
          tools: params.tool_calls.map((c) => c.tool),
          details: results.map((r) => ({ tool: r.tool, success: r.success })),
        },
      }
    },
  }
})
