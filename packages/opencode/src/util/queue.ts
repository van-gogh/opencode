/**
 * Queue 模块 - 异步队列
 *
 * 提供异步队列和并发工作池工具。
 *
 * @module util/queue
 */

/**
 * 异步队列
 *
 * 支持生产者-消费者模式的异步队列。
 * 实现 AsyncIterable，可用 for await...of 辭代。
 *
 * @template T - 队列元素类型
 *
 * @example
 * const queue = new AsyncQueue<string>()
 * // 生产者
 * queue.push("item1")
 * // 消费者
 * for await (const item of queue) {
 *   console.log(item)
 * }
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  /** 缓存的队列元素 */
  private queue: T[] = []
  /** 等待元素的解析器 */
  private resolvers: ((value: T) => void)[] = []

  /**
   * 向队列添加元素
   *
   * 如果有等待的消费者，直接交给消费者；
   * 否则添加到队列缓存。
   *
   * @param item - 要添加的元素
   */
  push(item: T) {
    const resolve = this.resolvers.shift()
    if (resolve) resolve(item)
    else this.queue.push(item)
  }

  /**
   * 获取下一个元素
   *
   * 如果队列为空，则等待直到有新元素。
   *
   * @returns 队列中的下一个元素
   */
  async next(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  /**
   * 异步迭代器实现
   *
   * 允许使用 for await...of 遍历队列
   */
  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }
}

/**
 * 并发工作池
 *
 * 以指定的并发数处理任务列表
 *
 * @param concurrency - 并发数
 * @param items - 要处理的任务列表
 * @param fn - 处理函数
 *
 * @example
 * await work(5, files, async (file) => {
 *   await processFile(file)
 * })
 */
export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const item = pending.pop()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}
