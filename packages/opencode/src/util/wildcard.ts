/**
 * Wildcard 模块 - 通配符匹配
 *
 * 本模块提供通配符模式匹配功能。
 *
 * 支持的通配符：
 * - *: 匹配任意数量的任意字符
 * - ?: 匹配单个任意字符
 *
 * 主要用途：
 * - 权限模式匹配
 * - 命令规则匹配
 *
 * @module util/wildcard
 */
import { sortBy, pipe } from "remeda" // 数据处理工具

/**
 * Wildcard 命名空间
 *
 * 提供通配符匹配功能
 */
export namespace Wildcard {
  /**
   * 匹配字符串与模式
   *
   * 将通配符模式转换为正则表达式进行匹配
   *
   * @param str - 要匹配的字符串
   * @param pattern - 通配符模式
   * @returns 是否匹配
   *
   * @example
   * match("hello.ts", "*.ts") // true
   * match("hello", "h?llo") // true
   */
  export function match(str: string, pattern: string) {
    let escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special regex chars
      .replace(/\*/g, ".*") // * becomes .*
      .replace(/\?/g, ".") // ? becomes .

    // If pattern ends with " *" (space + wildcard), make the trailing part optional
    // This allows "ls *" to match both "ls" and "ls -la"
    if (escaped.endsWith(" .*")) {
      escaped = escaped.slice(0, -3) + "( .*)?"
    }

    return new RegExp("^" + escaped + "$", "s").test(str)
  }

  /**
   * 查找所有匹配的模式值
   *
   * 按模式长度排序，返回最后一个匹配的值（最具体的匹配）
   *
   * @param input - 要匹配的字符串
   * @param patterns - 模式到值的映射
   * @returns 匹配的值，无匹配则返回 undefined
   *
   * @example
   * all("bash rm", { "bash": "allow", "bash rm*": "deny" }) // "deny"
   */
  export function all(input: string, patterns: Record<string, any>) {
    const sorted = pipe(patterns, Object.entries, sortBy([([key]) => key.length, "asc"], [([key]) => key, "asc"]))
    let result = undefined
    for (const [pattern, value] of sorted) {
      if (match(input, pattern)) {
        result = value
        continue
      }
    }
    return result
  }

  /**
   * 结构化匹配
   *
   * 支持多部分模式匹配，如 "bash rm *"
   *
   * @param input.head - 主命令
   * @param input.tail - 子命令/参数数组
   * @param patterns - 模式到值的映射
   * @returns 匹配的值
   *
   * @example
   * allStructured({ head: "bash", tail: ["rm", "-rf"] }, {
   *   "bash rm*": "deny",
   *   "bash": "allow"
   * }) // "deny"
   */
  export function allStructured(input: { head: string; tail: string[] }, patterns: Record<string, any>) {
    const sorted = pipe(patterns, Object.entries, sortBy([([key]) => key.length, "asc"], [([key]) => key, "asc"]))
    let result = undefined
    for (const [pattern, value] of sorted) {
      const parts = pattern.split(/\s+/)
      if (!match(input.head, parts[0])) continue
      if (parts.length === 1 || matchSequence(input.tail, parts.slice(1))) {
        result = value
        continue
      }
    }
    return result
  }

  /**
   * 序列匹配
   *
   * 检查 items 中是否存在按顺序匹配 patterns 的子序列
   *
   * @param items - 要匹配的项目数组
   * @param patterns - 模式数组
   * @returns 是否匹配
   */
  function matchSequence(items: string[], patterns: string[]): boolean {
    if (patterns.length === 0) return true
    const [pattern, ...rest] = patterns
    if (pattern === "*") return matchSequence(items, rest)
    for (let i = 0; i < items.length; i++) {
      if (match(items[i], pattern) && matchSequence(items.slice(i + 1), rest)) {
        return true
      }
    }
    return false
  }
}
