/**
 * Question 模块 - 问答系统
 *
 * 本模块提供 AI 与用户之间的交互式问答功能。
 * 当 AI 需要用户输入或确认时，可以发起问题，用户回复后继续执行。
 *
 * 主要功能：
 * - ask(): 发起问题，等待用户回复
 * - reply(): 用户提交回复
 * - reject(): 用户拒绝回答
 * - list(): 获取待回答的问题列表
 *
 * 工作流程：
 * 1. AI 调用 ask() 发起问题，返回 Promise
 * 2. 前端监听 Asked 事件并展示问题 UI
 * 3. 用户选择/输入回答后调用 reply()
 * 4. Promise 解析，AI 获取用户回复继续执行
 *
 * @module question
 */

import { Bus } from "@/bus" // 事件总线
import { BusEvent } from "@/bus/bus-event" // 事件定义
import { Identifier } from "@/id/id" // ID 生成
import { Instance } from "@/project/instance" // 项目实例
import { Log } from "@/util/log" // 日志工具
import z from "zod" // 参数验证

/**
 * Question 命名空间
 *
 * 提供问题的发起、回复和状态管理
 */
export namespace Question {
  // 问答模块的日志记录器
  const log = Log.create({ service: "question" })

  /**
   * 问题选项 Schema
   *
   * 定义单个选项的结构
   */
  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"), // 选项显示文本
      description: z.string().describe("Explanation of choice"), // 选项详细说明
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  /**
   * 问题信息 Schema
   *
   * 定义单个问题的完整结构
   */
  export const Info = z
    .object({
      question: z.string().describe("Complete question"), // 完整的问题文本
      header: z.string().max(12).describe("Very short label (max 12 chars)"), // 简短标签，最多 12 字符
      options: z.array(Option).describe("Available choices"), // 可选项列表
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  /**
   * 问题请求 Schema
   *
   * 定义发起问题的完整请求结构
   */
  export const Request = z
    .object({
      id: Identifier.schema("question"), // 问题 ID
      sessionID: Identifier.schema("session"), // 所属会话 ID
      questions: z.array(Info).describe("Questions to ask"), // 问题列表（支持批量提问）
      tool: z // 关联的工具调用信息（可选）
        .object({
          messageID: z.string(), // 消息 ID
          callID: z.string(), // 工具调用 ID
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  /**
   * 回复 Schema
   *
   * 定义用户回复的结构
   */
  export const Reply = z.object({
    answers: z.array(z.string()).describe("User answers in order of questions"), // 按问题顺序的回答列表
  })
  export type Reply = z.infer<typeof Reply>

  /**
   * 问答相关事件定义
   */
  export const Event = {
    /** 问题已发起事件 - 通知前端展示问题 UI */
    Asked: BusEvent.define("question.asked", Request),
    /** 用户已回复事件 */
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(), // 会话 ID
        requestID: z.string(), // 问题请求 ID
        answers: z.array(z.string()), // 用户回答
      }),
    ),
    /** 用户拒绝回答事件 */
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(), // 会话 ID
        requestID: z.string(), // 问题请求 ID
      }),
    ),
  }

  /**
   * 问答状态初始化
   *
   * 维护待回答问题的映射表
   */
  const state = Instance.state(async () => {
    // 待回答问题映射：ID -> { 问题信息, 解析回调, 拒绝回调 }
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: string[]) => void // Promise 解析回调
        reject: (e: any) => void // Promise 拒绝回调
      }
    > = {}

    return {
      pending,
    }
  })

  /**
   * 发起问题
   *
   * AI 调用此方法向用户提问，等待用户回复后返回
   *
   * @param input.sessionID - 会话 ID
   * @param input.questions - 问题列表
   * @param input.tool - 关联的工具调用信息（可选）
   * @returns 用户回答列表（与问题顺序对应）
   */
  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<string[]> {
    const s = await state()
    const id = Identifier.ascending("question") // 生成问题 ID

    log.info("asking", { id, questions: input.questions.length })

    // 返回 Promise，等待用户回复或拒绝
    return new Promise<string[]>((resolve, reject) => {
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      // 将问题添加到待回答列表
      s.pending[id] = {
        info,
        resolve,
        reject,
      }
      // 发布问题事件，通知前端展示 UI
      Bus.publish(Event.Asked, info)
    })
  }

  /**
   * 提交用户回复
   *
   * 前端调用此方法提交用户的回答
   *
   * @param input.requestID - 问题请求 ID
   * @param input.answers - 用户回答列表
   */
  export async function reply(input: { requestID: string; answers: string[] }): Promise<void> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }
    // 从待回答列表中移除
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    // 发布回复事件
    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    // 解析 Promise，让 AI 继续执行
    existing.resolve(input.answers)
  }

  /**
   * 拒绝回答问题
   *
   * 用户关闭问题 UI 或明确拒绝时调用
   *
   * @param requestID - 问题请求 ID
   */
  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    // 从待回答列表中移除
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    // 发布拒绝事件
    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    // 拒绝 Promise，抛出 RejectedError
    existing.reject(new RejectedError())
  }

  /**
   * 用户拒绝回答错误
   *
   * 当用户拒绝回答问题时抛出此错误
   */
  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  /**
   * 获取所有待回答的问题
   *
   * @returns 待回答问题请求列表
   */
  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
