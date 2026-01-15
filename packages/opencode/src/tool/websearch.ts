/**
 * WebSearchTool - 网页搜索工具
 *
 * 本工具提供实时网页搜索功能，基于 Exa AI 的 MCP 接口实现。
 * 
 * 主要功能：
 * - 搜索模式：auto（平衡）、fast（快速）、deep（深度）
 * - 实时爬取：支持实时获取最新内容
 * - 结果数量可配置
 * - 内容长度限制
 *
 * 使用场景：
 * - 获取最新技术信息
 * - 查找文档和教程
 * - 研究问题解决方案
 *
 * @module tool/websearch
 */

import z from "zod" // 参数验证
import { Tool } from "./tool" // 工具基础类
import DESCRIPTION from "./websearch.txt" // 工具描述

/**
 * API 配置常量
 */
const API_CONFIG = {
  BASE_URL: "https://mcp.exa.ai", // Exa AI MCP 基础 URL
  ENDPOINTS: {
    SEARCH: "/mcp", // 搜索端点
  },
  DEFAULT_NUM_RESULTS: 8, // 默认返回结果数
} as const

/**
 * MCP 搜索请求接口
 */
interface McpSearchRequest {
  jsonrpc: string // JSON-RPC 版本
  id: number // 请求 ID
  method: string // 方法名称
  params: {
    name: string // 工具名称
    arguments: {
      query: string // 搜索查询
      numResults?: number // 结果数量
      livecrawl?: "fallback" | "preferred" // 实时爬取模式
      type?: "auto" | "fast" | "deep" // 搜索类型
      contextMaxCharacters?: number // 上下文最大字符数
    }
  }
}

/**
 * MCP 搜索响应接口
 */
interface McpSearchResponse {
  jsonrpc: string // JSON-RPC 版本
  result: {
    content: Array<{
      type: string // 内容类型
      text: string // 搜索结果文本
    }>
  }
}

/**
 * 定义网页搜索工具
 */
export const WebSearchTool = Tool.define("websearch", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Websearch query"), // 搜索查询
    numResults: z.number().optional().describe("Number of search results to return (default: 8)"), // 结果数量
    livecrawl: z
      .enum(["fallback", "preferred"])
      .optional()
      .describe(
        // 实时爬取模式
        "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
      ),
    type: z
      .enum(["auto", "fast", "deep"])
      .optional()
      .describe(
        // 搜索类型
        "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
      ),
    contextMaxCharacters: z
      .number()
      .optional()
      .describe(
        // 上下文字符限制
        "Maximum characters for context string optimized for LLMs (default: 10000)",
      ),
  }),
  /**
   * 执行网页搜索
   */
  async execute(params, ctx) {
    // 请求权限
    await ctx.ask({
      permission: "websearch",
      patterns: [params.query],
      always: ["*"],
      metadata: {
        query: params.query,
        numResults: params.numResults,
        livecrawl: params.livecrawl,
        type: params.type,
        contextMaxCharacters: params.contextMaxCharacters,
      },
    })

    // 构建 MCP 搜索请求
    const searchRequest: McpSearchRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: params.query,
          type: params.type || "auto", // 默认使用 auto 模式
          numResults: params.numResults || API_CONFIG.DEFAULT_NUM_RESULTS,
          livecrawl: params.livecrawl || "fallback", // 默认使用 fallback 模式
          contextMaxCharacters: params.contextMaxCharacters,
        },
      },
    }

    // 设置请求超时（25 秒）
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 25000)

    try {
      // 设置请求头
      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      }

      // 发送搜索请求
      const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(searchRequest),
        signal: AbortSignal.any([controller.signal, ctx.abort]), // 支持取消
      })

      clearTimeout(timeoutId)

      // 检查响应状态
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Search error (${response.status}): ${errorText}`)
      }

      const responseText = await response.text()

      // 解析 SSE（Server-Sent Events）响应
      const lines = responseText.split("\n")
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data: McpSearchResponse = JSON.parse(line.substring(6))
          // 提取搜索结果
          if (data.result && data.result.content && data.result.content.length > 0) {
            return {
              output: data.result.content[0].text,
              title: `Web search: ${params.query}`,
              metadata: {},
            }
          }
        }
      }

      // 未找到结果
      return {
        output: "No search results found. Please try a different query.",
        title: `Web search: ${params.query}`,
        metadata: {},
      }
    } catch (error) {
      clearTimeout(timeoutId)

      // 处理超时错误
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Search request timed out")
      }

      throw error
    }
  },
})
