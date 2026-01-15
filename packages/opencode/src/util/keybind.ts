/**
 * Keybind 模块 - 键绑定处理
 *
 * 本模块提供键绑定解析和匹配功能。
 *
 * 主要功能：
 * - 解析键绑定字符串（如 "ctrl+c"、"alt+shift+p"）
 * - 支持 leader 键序列
 * - 键绑定匹配
 * - 转换为可读字符串
 *
 * @module util/keybind
 */
import { isDeepEqual } from "remeda" // 深度比较
import type { ParsedKey } from "@opentui/core" // TUI 键解析类型

/**
 * Keybind 命名空间
 *
 * 提供键绑定处理功能
 */
export namespace Keybind {
  /**
   * Keybind info derived from OpenTUI's ParsedKey with our custom `leader` field.
   * This ensures type compatibility and catches missing fields at compile time.
   */
  export type Info = Pick<ParsedKey, "name" | "ctrl" | "meta" | "shift" | "super"> & {
    leader: boolean // our custom field
  }

  /**
   * 匹配两个键绑定是否相同
   *
   * 考虑 super 字段的 undefined 和 false 等价
   *
   * @param a - 第一个键绑定
   * @param b - 第二个键绑定
   * @returns 是否匹配
   */
  export function match(a: Info, b: Info): boolean {
    // Normalize super field (undefined and false are equivalent)
    const normalizedA = { ...a, super: a.super ?? false }
    const normalizedB = { ...b, super: b.super ?? false }
    return isDeepEqual(normalizedA, normalizedB)
  }

  /**
   * Convert OpenTUI's ParsedKey to our Keybind.Info format.
   * This helper ensures all required fields are present and avoids manual object creation.
   */
  export function fromParsedKey(key: ParsedKey, leader = false): Info {
    return {
      name: key.name,
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift,
      super: key.super ?? false,
      leader,
    }
  }

  /**
   * 将键绑定转换为可读字符串
   *
   * @param info - 键绑定信息
   * @returns 可读字符串，如 "ctrl+shift+p"
   *
   * @example
   * toString({ ctrl: true, shift: true, name: "p" }) // "ctrl+shift+p"
   */
  export function toString(info: Info): string {
    const parts: string[] = []

    if (info.ctrl) parts.push("ctrl")
    if (info.meta) parts.push("alt")
    if (info.super) parts.push("super")
    if (info.shift) parts.push("shift")
    if (info.name) {
      if (info.name === "delete") parts.push("del")
      else parts.push(info.name)
    }

    let result = parts.join("+")

    if (info.leader) {
      result = result ? `<leader> ${result}` : `<leader>`
    }

    return result
  }

  /**
   * 解析键绑定字符串
   *
   * 支持的格式：
   * - 修饰键: ctrl, alt, meta, option, shift, super
   * - 特殊键: esc -> escape
   * - leader 键: <leader>
   * - 多组绑定: 用逗号分隔
   *
   * @param key - 键绑定字符串
   * @returns 键绑定信息数组
   *
   * @example
   * parse("ctrl+c") // [{ ctrl: true, name: "c", ... }]
   * parse("<leader> p") // [{ leader: true, name: "p", ... }]
   */
  export function parse(key: string): Info[] {
    if (key === "none") return []

    return key.split(",").map((combo) => {
      // Handle <leader> syntax by replacing with leader+
      const normalized = combo.replace(/<leader>/g, "leader+")
      const parts = normalized.toLowerCase().split("+")
      const info: Info = {
        ctrl: false,
        meta: false,
        shift: false,
        leader: false,
        name: "",
      }

      for (const part of parts) {
        switch (part) {
          case "ctrl":
            info.ctrl = true
            break
          case "alt":
          case "meta":
          case "option":
            info.meta = true
            break
          case "super":
            info.super = true
            break
          case "shift":
            info.shift = true
            break
          case "leader":
            info.leader = true
            break
          case "esc":
            info.name = "escape"
            break
          default:
            info.name = part
            break
        }
      }

      return info
    })
  }
}
