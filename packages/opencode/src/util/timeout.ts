/**
 * Timeout 模块 - 超时工具
 *
 * 提供为 Promise 添加超时限制的工具函数。
 *
 * @module util/timeout
 */

/**
 * 为 Promise 添加超时限制
 *
 * 如果 Promise 在指定时间内未完成，则抛出超时错误。
 *
 * @param promise - 要添加超时的 Promise
 * @param ms - 超时时间（毫秒）
 * @returns 带超时限制的 Promise
 * @throws 超时时抛出 Error
 *
 * @example
 * // MCP 连接超时
 * await withTimeout(client.connect(transport), 30000)
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout
  return Promise.race([
    promise.then((result) => {
      clearTimeout(timeout)
      return result
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Operation timed out after ${ms}ms`))
      }, ms)
    }),
  ])
}
