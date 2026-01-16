/**
 * MessageV2 模块 - 消息类型定义
 *
 * 本模块定义了 OpenCode 会话系统中所有消息相关的类型。
 *
 * 消息类型：
 * - User: 用户消息，包含用户输入和附件
 * - Assistant: AI 助手消息，包含输出、工具调用等
 *
 * 消息部分（Part）类型：
 * - TextPart: 文本内容
 * - ReasoningPart: 推理过程
 * - ToolPart: 工具调用（pending/running/completed/error）
 * - FilePart: 文件附件
 * - StepStartPart/StepFinishPart: 步骤边界
 * - SnapshotPart/PatchPart: 快照和补丁
 * - SubtaskPart: 子任务
 * - RetryPart: 重试记录
 * - AgentPart: Agent 切换
 * - CompactionPart: 上下文压缩标记
 *
 * 错误类型：
 * - OutputLengthError: 输出超长
 * - AbortedError: 被取消
 * - AuthError: 认证失败
 * - APIError: API 调用错误
 *
 * @module session/message-v2
 */

import { BusEvent } from "@/bus/bus-event" // 事件总线事件定义
import z from "zod" // Schema 验证库
import { NamedError } from "@opencode-ai/util/error" // 命名错误工具
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai" // AI SDK
import { Identifier } from "../id/id" // ID 生成
import { LSP } from "../lsp" // LSP 协议类型
import { Snapshot } from "@/snapshot" // 快照系统
import { fn } from "@/util/fn" // 函数工具
import { Storage } from "@/storage/storage" // 存储系统
import { ProviderTransform } from "@/provider/transform" // Provider 转换
import { STATUS_CODES } from "http" // HTTP 状态码
import { iife } from "@/util/iife" // 立即执行函数
import { type SystemError } from "bun" // Bun 系统错误类型

/**
 * MessageV2 命名空间
 *
 * 提供消息类型定义和消息操作函数
 */
export namespace MessageV2 {
  // ============ 错误类型定义 ============

  /** 输出超长错误：模型输出超过限制 */
  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))

  /** 被取消错误：用户或系统主动取消 */
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))

  /** 认证错误：API Key 无效或过期 */
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(), // 提供商 ID
      message: z.string(), // 错误信息
    }),
  )

  /**
   * API 调用错误
   *
   * 包含详细的响应信息以便调试
   */
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(), // 错误消息
      statusCode: z.number().optional(), // HTTP 状态码
      isRetryable: z.boolean(), // 是否可重试
      responseHeaders: z.record(z.string(), z.string()).optional(), // 响应头
      responseBody: z.string().optional(), // 响应体
      metadata: z.record(z.string(), z.string()).optional(), // 元数据
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>

  // ============ 消息部分基础类型 ============

  /** 消息部分的基础字段 */
  const PartBase = z.object({
    id: z.string(), // 部分 ID
    sessionID: z.string(), // 所属会话 ID
    messageID: z.string(), // 所属消息 ID
  })

  /** 快照部分：记录文件系统状态 */
  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(), // 快照 ID
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  /** 补丁部分：记录文件变更 */
  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(), // 补丁哈希
    files: z.string().array(), // 变更的文件列表
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  /** 文本部分：纯文本内容 */
  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(), // 文本内容
    synthetic: z.boolean().optional(), // 是否为合成的
    ignored: z.boolean().optional(), // 是否被忽略
    time: z
      .object({
        start: z.number(), // 开始时间
        end: z.number().optional(), // 结束时间
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(), // 元数据
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  /** 推理部分：AI 的推理过程 */
  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(), // 推理文本
    metadata: z.record(z.string(), z.any()).optional(), // 元数据
    time: z.object({
      start: z.number(), // 开始时间
      end: z.number().optional(), // 结束时间
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  // ============ 文件源类型 ============

  /** 文件源基础字段 */
  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(), // 文本内容
        start: z.number().int(), // 起始行
        end: z.number().int(), // 结束行
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  /** 文件源：来自文件系统 */
  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(), // 文件路径
  }).meta({
    ref: "FileSource",
  })

  /** 符号源：来自代码符号（函数、类等） */
  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(), // 文件路径
    range: LSP.Range, // 符号范围
    name: z.string(), // 符号名称
    kind: z.number().int(), // 符号类型（LSP SymbolKind）
  }).meta({
    ref: "SymbolSource",
  })

  /** 资源源：来自 MCP 资源 */
  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(), // MCP 客户端名称
    uri: z.string(), // 资源 URI
  }).meta({
    ref: "ResourceSource",
  })

  /** 文件部分源的联合类型 */
  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  /** 文件部分：图片、文档等附件 */
  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(), // MIME 类型
    filename: z.string().optional(), // 文件名
    url: z.string(), // 文件 URL（data URL 或路径）
    source: FilePartSource.optional(), // 文件源信息
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  // ============ 特殊部分类型 ============

  /** Agent 部分：记录 Agent 切换 */
  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(), // Agent 名称
    source: z
      .object({
        value: z.string(), // 源代码
        start: z.number().int(), // 起始位置
        end: z.number().int(), // 结束位置
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  /** 压缩部分：标记上下文压缩点 */
  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(), // 是否自动触发
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  /** 子任务部分：记录子任务信息 */
  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(), // 任务提示词
    description: z.string(), // 任务描述
    agent: z.string(), // 执行的 Agent
    command: z.string().optional(), // 可选的命令
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  /** 重试部分：记录 API 重试尝试 */
  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(), // 重试次数
    error: APIError.Schema, // 错误信息
    time: z.object({
      created: z.number(), // 创建时间
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  // ============ 步骤部分 ============

  /** 步骤开始部分：标记新步骤的开始 */
  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(), // 开始时的快照
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  /** 步骤完成部分：记录步骤结果和资源消耗 */
  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(), // 完成原因
    snapshot: z.string().optional(), // 结束时的快照
    cost: z.number(), // 费用
    tokens: z.object({
      input: z.number(), // 输入 token
      output: z.number(), // 输出 token
      reasoning: z.number(), // 推理 token
      cache: z.object({
        read: z.number(), // 缓存读取 token
        write: z.number(), // 缓存写入 token
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  // ============ 工具状态类型 ============

  /** 工具状态：等待中（输入中） */
  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()), // 部分输入
      raw: z.string(), // 原始 JSON 字符串
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  /** 工具状态：运行中 */
  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()), // 完整输入
      title: z.string().optional(), // 标题
      metadata: z.record(z.string(), z.any()).optional(), // 元数据
      time: z.object({
        start: z.number(), // 开始时间
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  /** 工具状态：完成 */
  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()), // 输入参数
      output: z.string(), // 输出结果
      title: z.string(), // 标题
      metadata: z.record(z.string(), z.any()), // 元数据
      time: z.object({
        start: z.number(), // 开始时间
        end: z.number(), // 结束时间
        compacted: z.number().optional(), // 压缩时间
      }),
      attachments: FilePart.array().optional(), // 附件（如截图）
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  /** 工具状态：错误 */
  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()), // 输入参数
      error: z.string(), // 错误信息
      metadata: z.record(z.string(), z.any()).optional(), // 元数据
      time: z.object({
        start: z.number(), // 开始时间
        end: z.number(), // 结束时间
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  /** 工具状态联合类型 */
  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  /** 工具部分：记录工具调用和结果 */
  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(), // 工具调用 ID
    tool: z.string(), // 工具名称
    state: ToolState, // 工具状态
    metadata: z.record(z.string(), z.any()).optional(), // Provider 元数据
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  // ============ 消息类型定义 ============

  /** 消息基础字段 */
  const Base = z.object({
    id: z.string(), // 消息 ID
    sessionID: z.string(), // 所属会话 ID
  })

  /**
   * 用户消息类型
   *
   * 包含用户输入的元数据，实际内容在 Parts 中
   */
  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(), // 创建时间
    }),
    summary: z
      .object({
        title: z.string().optional(), // 摘要标题
        body: z.string().optional(), // 摘要内容
        diffs: Snapshot.FileDiff.array(), // 文件变更
      })
      .optional(),
    agent: z.string(), // 使用的 Agent
    model: z.object({
      providerID: z.string(), // Provider ID
      modelID: z.string(), // 模型 ID
    }),
    system: z.string().optional(), // 系统提示词变体
    tools: z.record(z.string(), z.boolean()).optional(), // 工具启用状态
    variant: z.string().optional(), // 变体标识
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  /** 所有消息部分类型的联合 */
  export const Part = z
    .discriminatedUnion("type", [
      TextPart, // 文本
      SubtaskPart, // 子任务
      ReasoningPart, // 推理
      FilePart, // 文件
      ToolPart, // 工具调用
      StepStartPart, // 步骤开始
      StepFinishPart, // 步骤结束
      SnapshotPart, // 快照
      PatchPart, // 补丁
      AgentPart, // Agent
      RetryPart, // 重试
      CompactionPart, // 压缩
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  /**
   * AI 助手消息类型
   *
   * 包含 AI 输出的元数据，实际内容在 Parts 中
   */
  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(), // 创建时间
      completed: z.number().optional(), // 完成时间
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema, // 认证错误
        NamedError.Unknown.Schema, // 未知错误
        OutputLengthError.Schema, // 输出超长
        AbortedError.Schema, // 被取消
        APIError.Schema, // API 错误
      ])
      .optional(),
    parentID: z.string(), // 父消息 ID（用户消息）
    modelID: z.string(), // 模型 ID
    providerID: z.string(), // Provider ID
    /**
     * @deprecated 已废弃，使用 agent 代替
     */
    mode: z.string(),
    agent: z.string(), // 使用的 Agent
    path: z.object({
      cwd: z.string(), // 当前工作目录
      root: z.string(), // 项目根目录
    }),
    summary: z.boolean().optional(), // 是否为摘要消息
    cost: z.number(), // 总费用
    tokens: z.object({
      input: z.number(), // 输入 token
      output: z.number(), // 输出 token
      reasoning: z.number(), // 推理 token
      cache: z.object({
        read: z.number(), // 缓存读取
        write: z.number(), // 缓存写入
      }),
    }),
    finish: z.string().optional(), // 完成原因
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  /** 消息类型联合（User | Assistant） */
  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  // ============ 事件定义 ============

  /** 消息相关事件 */
  export const Event = {
    /** 消息更新事件 */
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    /** 消息删除事件 */
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    /** 消息部分更新事件 */
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(), // 增量更新
      }),
    ),
    /** 消息部分删除事件 */
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  /** 消息及其所有部分的组合类型 */
  export const WithParts = z.object({
    info: Info, // 消息信息
    parts: z.array(Part), // 消息部分列表
  })
  export type WithParts = z.infer<typeof WithParts>

  export function toModelMessage(input: WithParts[]): ModelMessage[] {
    const result: UIMessage[] = []

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory")
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        for (const part of msg.parts) {
          if (part.type === "text")
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              providerMetadata: part.metadata,
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            if (part.state.status === "completed") {
              if (part.state.attachments?.length) {
                result.push({
                  id: Identifier.ascending("message"),
                  role: "user",
                  parts: [
                    {
                      type: "text",
                      text: `Tool ${part.tool} returned an attachment:`,
                    },
                    ...part.state.attachments.map((attachment) => ({
                      type: "file" as const,
                      url: attachment.url,
                      mediaType: attachment.mime,
                      filename: attachment.filename,
                    })),
                  ],
                })
              }
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output: part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output,
                callProviderMetadata: part.metadata,
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                callProviderMetadata: part.metadata,
              })
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              providerMetadata: part.metadata,
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    return convertToModelMessages(result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")))
  }

  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    for (let i = list.length - 1; i >= 0; i--) {
      yield await get({
        sessionID,
        messageID: list[i][2],
      })
    }
  })

  export const parts = fn(Identifier.schema("message"), async (messageID) => {
    const result = [] as MessageV2.Part[]
    for (const item of await Storage.list(["part", messageID])) {
      const read = await Storage.read<MessageV2.Part>(item)
      result.push(read)
    }
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  })

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      return {
        info: await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID]),
        parts: await parts(input.messageID),
      }
    },
  )

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    for await (const msg of stream) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) completed.add(msg.info.parentID)
    }
    result.reverse()
    return result
  }

  export function fromError(e: unknown, ctx: { providerID: string }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const message = iife(() => {
          let msg = e.message
          if (msg === "") {
            if (e.responseBody) return e.responseBody
            if (e.statusCode) {
              const err = STATUS_CODES[e.statusCode]
              if (err) return err
            }
            return "Unknown error"
          }
          const transformed = ProviderTransform.error(ctx.providerID, e)
          if (transformed !== msg) {
            return transformed
          }
          if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
            return msg
          }

          try {
            const body = JSON.parse(e.responseBody)
            // try to extract common error message fields
            const errMsg = body.message || body.error || body.error?.message
            if (errMsg && typeof errMsg === "string") {
              return `${msg}: ${errMsg}`
            }
          } catch {}

          return `${msg}: ${e.responseBody}`
        }).trim()

        const metadata = e.url ? { url: e.url } : undefined
        return new MessageV2.APIError(
          {
            message,
            statusCode: e.statusCode,
            isRetryable: e.isRetryable,
            responseHeaders: e.responseHeaders,
            responseBody: e.responseBody,
            metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e })
    }
  }
}
