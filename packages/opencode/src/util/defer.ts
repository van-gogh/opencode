/**
 * Defer 模块 - 延迟执行工具
 *
 * 提供将函数包装为 Disposable 对象的工具。
 * 配合 using 语法，实现自动清理。
 *
 * @module util/defer
 */

/**
 * 创建延迟执行对象
 *
 * 将清理函数包装为 Disposable，用于自动清理资源。
 *
 * @param fn - 要延迟执行的函数
 * @returns Disposable 对象
 *
 * @example
 * using _ = defer(() => connection.close())
 * // 使用 connection...
 * // 作用域结束时自动关闭连接
 */
export function defer<T extends () => void | Promise<void>>(
  fn: T,
): T extends () => Promise<void> ? { [Symbol.asyncDispose]: () => Promise<void> } : { [Symbol.dispose]: () => void } {
  return {
    [Symbol.dispose]() {
      fn()
    },
    [Symbol.asyncDispose]() {
      return Promise.resolve(fn())
    },
  } as any
}
