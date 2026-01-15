/**
 * GlobalBus 模块 - 全局事件总线实例
 *
 * 本模块导出全局共享的事件总线实例，用于跨项目实例的事件传递。
 * 
 * 主要用途：
 * - 全局事件广播：所有项目实例都能接收到事件
 * - 服务器推送：将事件转发给连接的客户端
 *
 * 事件负载包含：
 * - directory: 项目目录（用于过滤特定项目的事件）
 * - payload: 实际的事件数据
 *
 * @module bus/global
 */

import { EventEmitter } from "events" // Node.js 事件发射器

/**
 * 全局事件总线实例
 *
 * 发出的事件将被所有监听者接收
 */
export const GlobalBus = new EventEmitter<{
  event: [ // 事件名称
    {
      directory?: string // 项目目录（可选）
      payload: any // 事件数据
    },
  ]
}>()
