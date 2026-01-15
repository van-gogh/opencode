/**
 * Agent 模块 - AI 代理管理
 *
 * 本模块负责管理 OpenCode 中的各种 AI Agent（代理）。
 * Agent 是一种可配置的 AI 交互模式，定义了：
 * - 使用哪个模型
 * - 系统提示词
 * - 可用的工具和权限
 * - 采样参数（temperature, topP）
 *
 * 内置 Agent 类型：
 * - build: 主要的构建 Agent，用于代码编写和执行任务
 * - plan: 规划 Agent，用于制定任务计划
 * - general: 通用子 Agent，用于研究和多步骤任务
 * - explore: 探索子 Agent，用于快速探索代码库
 * - compaction: 压缩 Agent，用于压缩上下文
 * - title: 标题 Agent，用于生成会话标题
 * - summary: 摘要 Agent，用于生成会话摘要
 *
 * Agent 模式：
 * - primary: 主 Agent，可以直接被用户使用
 * - subagent: 子 Agent，只能被其他 Agent 调用
 * - all: 两种模式都支持
 *
 * @module agent
 */

import { Config } from "../config/config" // 配置管理
import z from "zod" // 参数验证
import { Provider } from "../provider/provider" // Provider 管理
import { generateObject, type ModelMessage } from "ai" // AI SDK
import { SystemPrompt } from "../session/system" // 系统提示词
import { Instance } from "../project/instance" // 项目实例
import { Truncate } from "../tool/truncation" // 截断工具

// 内置提示词模板
import PROMPT_GENERATE from "./generate.txt" // Agent 生成提示词
import PROMPT_COMPACTION from "./prompt/compaction.txt" // 压缩提示词
import PROMPT_EXPLORE from "./prompt/explore.txt" // 探索提示词
import PROMPT_SUMMARY from "./prompt/summary.txt" // 摘要提示词
import PROMPT_TITLE from "./prompt/title.txt" // 标题生成提示词
import { PermissionNext } from "@/permission/next" // 权限系统
import { mergeDeep, pipe, sortBy, values } from "remeda" // 函数式工具

/**
 * Agent 命名空间
 *
 * 包含 Agent 配置、管理和生成的所有功能
 */
export namespace Agent {
  /**
   * Agent 信息定义
   * 定义了 Agent 的基本属性、权限、模型配置等
   */
  export const Info = z
    .object({
      name: z.string(), // Agent 名称
      description: z.string().optional(), // Agent 描述
      mode: z.enum(["subagent", "primary", "all"]), // Agent 模式：子代理、主代理或全部
      native: z.boolean().optional(), // 是否为原生内置 Agent
      hidden: z.boolean().optional(), // 是否隐藏
      topP: z.number().optional(), // 采样参数 topP
      temperature: z.number().optional(), // 采样参数 temperature
      color: z.string().optional(), // UI 显示颜色
      permission: PermissionNext.Ruleset, // 权限规则集
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(), // 指定使用的模型
      prompt: z.string().optional(), // 系统提示词
      options: z.record(z.string(), z.any()), // 其他选项
      steps: z.number().int().positive().optional(), // 最大步数限制
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  /**
   * 状态管理，包含所有可用的 Agent 配置
   * 包含内置 Agent（build, plan, general, explore 等）和用户配置的 Agent
   */
  const state = Instance.state(async () => {
    const cfg = await Config.get()

    // 默认权限配置
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        [Truncate.DIR]: "allow",
      },
      question: "deny",
      // 模仿 github.com/github/gitignore Node.gitignore 对 .env 文件的模式
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      // 构建代理：处理构建任务
      build: {
        name: "build",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      // 计划代理：负责制定任务计划
      plan: {
        name: "plan",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            edit: {
              "*": "deny",
              ".opencode/plan/*.md": "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      // 通用代理：用于研究复杂问题和执行多步骤任务
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      // 探索代理：用于快速探索代码库
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      // 压缩代理：用于压缩上下文
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      // 标题生成代理
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      // 摘要生成代理
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
    }
    return result
  })

  /**
   * 获取指定名称的 Agent 信息
   * @param agent Agent 名称
   */
  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  /**
   * 列出所有可用的 Agent，并按默认或 build Agent 排序
   */
  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"]),
    )
  }

  /**
   * 获取默认的 Agent 名称
   */
  export async function defaultAgent() {
    return state().then((x) => Object.keys(x)[0])
  }

  /**
   * 根据描述生成新的 Agent 配置
   * 使用 LLM 根据用户输入的需求自动生成 Agent 配置
   * @param input 包含描述和可选的模型信息
   */
  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)
    const system = SystemPrompt.header(defaultModel.providerID)
    system.push(PROMPT_GENERATE)
    const existing = await list()
    const result = await generateObject({
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    })
    return result.object
  }
}
