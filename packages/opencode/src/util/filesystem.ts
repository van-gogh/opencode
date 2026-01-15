/**
 * Filesystem 模块 - 文件系统工具
 *
 * 本模块提供文件系统相关的工具函数。
 *
 * 主要功能：
 * - 路径标准化（Windows 大小写处理）
 * - 路径关系检测（重叠、包含）
 * - 向上搜索文件（从当前目录到根目录）
 * - Glob 模式匹配
 *
 * @module util/filesystem
 */
import { realpathSync } from "fs" // 用于获取真实路径
import { exists } from "fs/promises" // 文件存在检查
import { dirname, join, relative } from "path" // 路径处理

/**
 * Filesystem 命名空间
 *
 * 提供文件系统工具函数
 */
export namespace Filesystem {
  /**
   * On Windows, normalize a path to its canonical casing using the filesystem.
   * This is needed because Windows paths are case-insensitive but LSP servers
   * may return paths with different casing than what we send them.
   */
  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  /**
   * 检查两个路径是否重叠
   *
   * 如果 a 包含 b 或 b 包含 a，则认为重叠
   *
   * @param a - 第一个路径
   * @param b - 第二个路径
   * @returns 是否重叠
   */
  export function overlaps(a: string, b: string) {
    const relA = relative(a, b)
    const relB = relative(b, a)
    return !relA || !relA.startsWith("..") || !relB || !relB.startsWith("..")
  }

  /**
   * 检查父路径是否包含子路径
   *
   * @param parent - 父路径
   * @param child - 子路径
   * @returns child 是否在 parent 内
   */
  export function contains(parent: string, child: string) {
    return !relative(parent, child).startsWith("..")
  }

  /**
   * 向上搜索指定文件
   *
   * 从 start 目录开始，向上遍历到 stop 或根目录，
   * 查找所有匹配 target 的文件。
   *
   * @param target - 要搜索的文件名
   * @param start - 开始目录
   * @param stop - 停止目录（可选）
   * @returns 找到的文件路径数组
   *
   * @example
   * // 搜索 package.json
   * const files = await findUp("package.json", "/path/to/project/src")
   */
  export async function findUp(target: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      const search = join(current, target)
      if (await exists(search).catch(() => false)) result.push(search)
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  /**
   * 向上搜索生成器
   *
   * 与 findUp 类似，但返回生成器，可以支持多个目标文件
   *
   * @param options.targets - 要搜索的文件名数组
   * @param options.start - 开始目录
   * @param options.stop - 停止目录（可选）
   * @yields 找到的文件路径
   */
  export async function* up(options: { targets: string[]; start: string; stop?: string }) {
    const { targets, start, stop } = options
    let current = start
    while (true) {
      for (const target of targets) {
        const search = join(current, target)
        if (await exists(search).catch(() => false)) yield search
      }
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  /**
   * 向上搜索并 Glob 匹配
   *
   * 从 start 目录开始，向上遍历，在每个目录中执行 glob 匹配
   *
   * @param pattern - Glob 模式
   * @param start - 开始目录
   * @param stop - 停止目录（可选）
   * @returns 匹配的文件路径数组
   */
  export async function globUp(pattern: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      try {
        const glob = new Bun.Glob(pattern)
        for await (const match of glob.scan({
          cwd: current,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
          dot: true,
        })) {
          result.push(match)
        }
      } catch {
        // Skip invalid glob patterns
      }
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }
}
