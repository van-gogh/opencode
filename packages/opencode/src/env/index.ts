/**
 * Env 模块 - 环境变量管理
 *
 * 本模块提供项目级别的环境变量管理功能。
 * 每个项目实例拥有独立的环境变量副本，修改不影响全局环境。
 *
 * 主要功能：
 * - get(): 获取单个环境变量
 * - all(): 获取所有环境变量
 * - set(): 设置环境变量
 * - remove(): 删除环境变量
 *
 * @module env
 */

import { Instance } from "../project/instance" // 项目实例

/**
 * Env 命名空间
 *
 * 提供环境变量的读写接口
 */
export namespace Env {
  /**
   * 环境变量状态
   * 使用 Instance.state 确保每个项目有独立的环境副本
   */
  const state = Instance.state(() => {
    return process.env as Record<string, string | undefined>
  })

  /**
   * 获取指定环境变量
   *
   * @param key - 环境变量名
   * @returns 环境变量值，不存在返回 undefined
   */
  export function get(key: string) {
    const env = state()
    return env[key]
  }

  /**
   * 获取所有环境变量
   *
   * @returns 环境变量对象
   */
  export function all() {
    return state()
  }

  /**
   * 设置环境变量
   *
   * @param key - 环境变量名
   * @param value - 环境变量值
   */
  export function set(key: string, value: string) {
    const env = state()
    env[key] = value
  }

  /**
   * 删除环境变量
   *
   * @param key - 环境变量名
   */
  export function remove(key: string) {
    const env = state()
    delete env[key]
  }
}
