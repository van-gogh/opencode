/**
 * SessionProcessor 模块 - 会话流处理器
 *
 * 本模块是 OpenCode 的核心处理器，负责处理 AI 响应流。
 *
 * 主要功能：
 * - 处理 LLM 输出流（文本、推理、工具调用等）
 * - 管理工具执行和结果收集
 * - 处理重试逻辑和错误恢复
 * - 检测工具调用循环（doom loop）
 * - 触发上下文压缩
 * - 记录 token 使用量和成本
 *
 * 流处理事件类型：
 * - start: 开始处理
 * - text-*: 文本输出（开始、增量、结束）
 * - reasoning-*: 推理过程（开始、增量、结束）
 * - tool-*: 工具调用（输入、执行、结果、错误）
 * - start-step/finish-step: 步骤边界
 * - error: 错误处理
 *
 * @module session/processor
 */

import { MessageV2 } from "./message-v2" // 消息类型定义
import { Log } from "@/util/log" // 日志工具
import { Identifier } from "@/id/id" // ID 生成
import { Session } from "." // 会话管理
import { Agent } from "@/agent/agent" // Agent 管理
import { Snapshot } from "@/snapshot" // 快照系统
import { SessionSummary } from "./summary" // 会话摘要
import { Bus } from "@/bus" // 事件总线
import { SessionRetry } from "./retry" // 重试逻辑
import { SessionStatus } from "./status" // 会话状态
import { Plugin } from "@/plugin" // 插件系统
import type { Provider } from "@/provider/provider" // Provider 类型
import { LLM } from "./llm" // LLM 调用
import { Config } from "@/config/config" // 配置管理
import { SessionCompaction } from "./compaction" // 上下文压缩
import { PermissionNext } from "@/permission/next" // 权限系统
import { Question } from "@/question" // 用户问题系统

/**
 * SessionProcessor 命名空间
 *
 * 提供会话流处理的核心功能
 */
export namespace SessionProcessor {
  /**
   * “死亡循环”检测阈值
   * 当同一工具以相同参数连续调用超过此次数时，触发警告
   */
  const DOOM_LOOP_THRESHOLD = 3

  // 创建会话处理器专用的日志记录器
  const log = Log.create({ service: "session.processor" })

  /** 处理器实例类型 */
  export type Info = Awaited<ReturnType<typeof create>>
  /** 处理结果类型 */
  export type Result = Awaited<ReturnType<Info["process"]>>

  /**
   * 创建会话处理器实例
   *
   * @param input - 输入参数
   * @param input.assistantMessage - 助手消息对象
   * @param input.sessionID - 会话 ID
   * @param input.model - 使用的模型
   * @param input.abort - 取消信号
   * @returns 处理器实例
   */
  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    // 工具调用映射表：callID -> ToolPart
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    // 当前快照 ID
    let snapshot: string | undefined
    // 是否被权限拒绝阻止
    let blocked = false
    // 重试次数
    let attempt = 0
    // 是否需要上下文压缩
    let needsCompaction = false

    const result = {
      /** 获取当前助手消息 */
      get message() {
        return input.assistantMessage
      },

      /**
       * 根据工具调用 ID 获取对应的 Part
       * @param toolCallID - 工具调用 ID
       */
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },

      /**
       * 主处理循环
       *
       * 处理 LLM 输出流，直到会话完成、被阻止或需要压缩
       *
       * @param streamInput - LLM 流输入
       * @returns "continue" | "stop" | "compact"
       */
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        // 检查是否在权限拒绝时继续循环
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true

        // 主处理循环
        while (true) {
          try {
            // 当前文本部分
            let currentText: MessageV2.TextPart | undefined
            // 推理部分映射表
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            // 获取 LLM 流
            const stream = await LLM.stream(streamInput)

            // 遍历流事件
            for await (const value of stream.fullStream) {
              // 检查是否被取消
              input.abort.throwIfAborted()

              switch (value.type) {
                // ============ 会话开始 ============
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                // ============ 推理处理 ============
                case "reasoning-start":
                  // 创建新的推理部分
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  // 追加推理文本
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  // 完成推理部分
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                // ============ 工具调用处理 ============
                case "tool-input-start":
                  // 工具调用开始，创建 pending 状态的 Part
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  // 工具输入增量（当前未使用）
                  break

                case "tool-input-end":
                  // 工具输入结束（当前未使用）
                  break

                case "tool-call": {
                  // 工具开始执行，更新为 running 状态
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    // 检测“死亡循环”：同一工具以相同参数连续调用
                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      // 触发“死亡循环”权限检查
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }

                case "tool-result": {
                  // 工具执行成功，更新为 completed 状态
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  // 工具执行失败，更新为 error 状态
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    // 检查是否因权限被拒绝
                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "error":
                  // 流处理错误
                  throw value.error

                // ============ 步骤管理 ============
                case "start-step":
                  // 新步骤开始，记录快照
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  // 步骤完成，计算 token 和成本
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens

                  // 记录步骤完成
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)

                  // 记录文件变更补丁
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }

                  // 触发会话摘要生成
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })

                  // 检查是否需要上下文压缩
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                // ============ 文本输出处理 ============
                case "text-start":
                  // 开始新的文本部分
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  // 追加文本增量
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  // 完成文本部分
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    // 触发插件钩子
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  // 流完成
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              // 如果需要压缩，提前退出
              if (needsCompaction) break
            }
          } catch (e: any) {
            // ============ 错误处理 ============
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })

            // 检查是否可重试
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              // 设置重试状态
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }

            // 不可重试的错误，记录并发布事件
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }

          // ============ 清理工作 ============
          // 保存最终快照补丁
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }

          // 清理未完成的工具调用
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }

          // 标记消息完成
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)

          // 返回处理结果
          if (needsCompaction) return "compact" // 需要压缩
          if (blocked) return "stop" // 被阻止
          if (input.assistantMessage.error) return "stop" // 发生错误
          return "continue" // 继续处理
        }
      },
    }
    return result
  }
}
