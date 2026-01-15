/**
 * Lazy 模块 - 延迟初始化
 *
 * 提供延迟计算（懒加载）工具。
 * 值仅在第一次访问时计算，之后缓存结果。
 *
 * @module util/lazy
 */

/**
 * 创建懒加载值
 *
 * @param fn - 初始化函数
 * @returns 获取值的函数（带 reset 方法）
 *
 * @example
 * const getConfig = lazy(() => loadConfig())
 * // 第一次调用时执行 loadConfig
 * const config1 = getConfig()
 * // 第二次调用返回缓存值
 * const config2 = getConfig()
 * // 重置后下次调用会重新计算
 * getConfig.reset()
 */
export function lazy<T>(fn: () => T) {
  let value: T | undefined // 缓存的值
  let loaded = false // 是否已加载

  /**
   * 获取值
   *
   * 如果未加载，则执行初始化函数。
   */
  const result = (): T => {
    if (loaded) return value as T
    loaded = true
    value = fn()
    return value as T
  }

  /**
   * 重置缓存
   *
   * 清除缓存的值，下次访问时重新计算。
   */
  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
