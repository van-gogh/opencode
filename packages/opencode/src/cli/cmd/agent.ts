/**
 * Agent 命令 - 自定义 Agent 管理
 *
 * 本模块实现 `opencode agent` 命令。
 *
 * 主要功能：
 * - 创建自定义 Agent
 * - 列出所有可用 Agent
 * - 支持交互式和非交互式模式
 *
 * @module cli/cmd/agent
 */
import { cmd } from "./cmd" // 命令定义
import * as prompts from "@clack/prompts" // 交互式提示
import { UI } from "../ui" // UI 工具
import { Global } from "../../global" // 全局路径
import { Agent } from "../../agent/agent" // Agent 模块
import { Provider } from "../../provider/provider" // Provider 模块
import path from "path" // 路径处理
import fs from "fs/promises" // 文件系统
import matter from "gray-matter" // Frontmatter 解析
import { Instance } from "../../project/instance" // 项目实例
import { EOL } from "os" // 行结束符
import type { Argv } from "yargs" // CLI 参数解析

/**
 * Agent 模式类型
 *
 * - all: 可以作为主 Agent 或子 Agent
 * - primary: 仅作为主 Agent
 * - subagent: 仅作为子 Agent
 */
type AgentMode = "all" | "primary" | "subagent"

/**
 * 可用工具列表
 */
const AVAILABLE_TOOLS = [
  "bash", // Shell 命令
  "read", // 文件读取
  "write", // 文件写入
  "edit", // 文件编辑
  "list", // 目录列表
  "glob", // 文件搜索
  "grep", // 内容搜索
  "webfetch", // 网页访问
  "task", // 子任务
  "todowrite", // 任务写入
  "todoread", // 任务读取
]

/**
 * Agent Create 子命令
 *
 * 创建新的自定义 Agent，支持交互式和非交互式模式
 */
const AgentCreateCommand = cmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("tools", {
        type: "string",
        describe: `comma-separated list of tools to enable (default: all). Available: "${AVAILABLE_TOOLS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const cliPath = args.path
        const cliDescription = args.description
        const cliMode = args.mode as AgentMode | undefined
        const cliTools = args.tools

        const isFullyNonInteractive = cliPath && cliDescription && cliMode && cliTools !== undefined

        if (!isFullyNonInteractive) {
          UI.empty()
          prompts.intro("Create agent")
        }

        const project = Instance.project

        // Determine scope/path
        let targetPath: string
        if (cliPath) {
          targetPath = path.join(cliPath, "agent")
        } else {
          let scope: "global" | "project" = "global"
          if (project.vcs === "git") {
            const scopeResult = await prompts.select({
              message: "Location",
              options: [
                {
                  label: "Current project",
                  value: "project" as const,
                  hint: Instance.worktree,
                },
                {
                  label: "Global",
                  value: "global" as const,
                  hint: Global.Path.config,
                },
              ],
            })
            if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
            scope = scopeResult
          }
          targetPath = path.join(
            scope === "global" ? Global.Path.config : path.join(Instance.worktree, ".opencode"),
            "agent",
          )
        }

        // Get description
        let description: string
        if (cliDescription) {
          description = cliDescription
        } else {
          const query = await prompts.text({
            message: "Description",
            placeholder: "What should this agent do?",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          })
          if (prompts.isCancel(query)) throw new UI.CancelledError()
          description = query
        }

        // Generate agent
        const spinner = prompts.spinner()
        spinner.start("Generating agent configuration...")
        const model = args.model ? Provider.parseModel(args.model) : undefined
        const generated = await Agent.generate({ description, model }).catch((error) => {
          spinner.stop(`LLM failed to generate agent: ${error.message}`, 1)
          if (isFullyNonInteractive) process.exit(1)
          throw new UI.CancelledError()
        })
        spinner.stop(`Agent ${generated.identifier} generated`)

        // Select tools
        let selectedTools: string[]
        if (cliTools !== undefined) {
          selectedTools = cliTools ? cliTools.split(",").map((t) => t.trim()) : AVAILABLE_TOOLS
        } else {
          const result = await prompts.multiselect({
            message: "Select tools to enable",
            options: AVAILABLE_TOOLS.map((tool) => ({
              label: tool,
              value: tool,
            })),
            initialValues: AVAILABLE_TOOLS,
          })
          if (prompts.isCancel(result)) throw new UI.CancelledError()
          selectedTools = result
        }

        // Get mode
        let mode: AgentMode
        if (cliMode) {
          mode = cliMode
        } else {
          const modeResult = await prompts.select({
            message: "Agent mode",
            options: [
              {
                label: "All",
                value: "all" as const,
                hint: "Can function in both primary and subagent roles",
              },
              {
                label: "Primary",
                value: "primary" as const,
                hint: "Acts as a primary/main agent",
              },
              {
                label: "Subagent",
                value: "subagent" as const,
                hint: "Can be used as a subagent by other agents",
              },
            ],
            initialValue: "all" as const,
          })
          if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
          mode = modeResult
        }

        // Build tools config
        const tools: Record<string, boolean> = {}
        for (const tool of AVAILABLE_TOOLS) {
          if (!selectedTools.includes(tool)) {
            tools[tool] = false
          }
        }

        // Build frontmatter
        const frontmatter: {
          description: string
          mode: AgentMode
          tools?: Record<string, boolean>
        } = {
          description: generated.whenToUse,
          mode,
        }
        if (Object.keys(tools).length > 0) {
          frontmatter.tools = tools
        }

        // Write file
        const content = matter.stringify(generated.systemPrompt, frontmatter)
        const filePath = path.join(targetPath, `${generated.identifier}.md`)

        await fs.mkdir(targetPath, { recursive: true })

        const file = Bun.file(filePath)
        if (await file.exists()) {
          if (isFullyNonInteractive) {
            console.error(`Error: Agent file already exists: ${filePath}`)
            process.exit(1)
          }
          prompts.log.error(`Agent file already exists: ${filePath}`)
          throw new UI.CancelledError()
        }

        await Bun.write(filePath, content)

        if (isFullyNonInteractive) {
          console.log(filePath)
        } else {
          prompts.log.success(`Agent created: ${filePath}`)
          prompts.outro("Done")
        }
      },
    })
  },
})

/**
 * Agent List 子命令
 *
 * 列出所有可用的 Agent
 */
const AgentListCommand = cmd({
  command: "list",
  describe: "list all available agents",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const agents = await Agent.list()
        const sortedAgents = agents.sort((a, b) => {
          if (a.native !== b.native) {
            return a.native ? -1 : 1
          }
          return a.name.localeCompare(b.name)
        })

        for (const agent of sortedAgents) {
          process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
          process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
        }
      },
    })
  },
})

/**
 * Agent 命令定义
 *
 * 父命令，包含子命令 create 和 list
 */
export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  async handler() {},
})
