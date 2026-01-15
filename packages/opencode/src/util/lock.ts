/**
 * Lock 模块 - 读写锁
 *
 * 本模块提供异步读写锁实现。
 *
 * 主要特点：
 * - 支持多读单写（读写互斥）
 * - 写者优先（防止写者饥饿）
 * - 支持 Symbol.dispose（可与 using 一起使用）
 * - 自动清理不再使用的锁
 *
 * @module util/lock
 */

/**
 * Lock 命名空间
 *
 * 提供读写锁功能
 */
export namespace Lock {
  /**
   * 锁状态存储
   *
   * 为每个唯一的键维护一个锁状态
   */
  const locks = new Map<
    string,
    {
      readers: number // 当前读者数量
      writer: boolean // 是否有写者
      waitingReaders: (() => void)[] // 等待的读者
      waitingWriters: (() => void)[] // 等待的写者
    }
  >()

  /**
   * 获取或创建锁状态
   *
   * @param key - 锁的键
   * @returns 锁状态
   */
  function get(key: string) {
    if (!locks.has(key)) {
      locks.set(key, {
        readers: 0,
        writer: false,
        waitingReaders: [],
        waitingWriters: [],
      })
    }
    return locks.get(key)!
  }

  /**
   * 处理锁释放后的等待队列
   *
   * 写者优先：先唤醒等待的写者，再唤醒所有等待的读者
   *
   * @param key - 锁的键
   */
  function process(key: string) {
    const lock = locks.get(key)
    if (!lock || lock.writer || lock.readers > 0) return

    // 写者优先，防止写者饥饿
    if (lock.waitingWriters.length > 0) {
      const nextWriter = lock.waitingWriters.shift()!
      nextWriter()
      return
    }

    // 唤醒所有等待的读者
    while (lock.waitingReaders.length > 0) {
      const nextReader = lock.waitingReaders.shift()!
      nextReader()
    }

    // 清理空的锁
    if (lock.readers === 0 && !lock.writer && lock.waitingReaders.length === 0 && lock.waitingWriters.length === 0) {
      locks.delete(key)
    }
  }

  /**
   * 获取读锁
   *
   * 多个读者可以同时持有读锁，但在有写者或等待写者时会等待
   *
   * @param key - 锁的键
   * @returns Disposable 对象，调用 dispose 释放锁
   *
   * @example
   * using lock = await Lock.read("file.ts")
   * // 读取文件...
   * // lock 会在作用域结束时自动释放
   */
  export async function read(key: string): Promise<Disposable> {
    const lock = get(key)

    return new Promise((resolve) => {
      if (!lock.writer && lock.waitingWriters.length === 0) {
        lock.readers++
        resolve({
          [Symbol.dispose]: () => {
            lock.readers--
            process(key)
          },
        })
      } else {
        lock.waitingReaders.push(() => {
          lock.readers++
          resolve({
            [Symbol.dispose]: () => {
              lock.readers--
              process(key)
            },
          })
        })
      }
    })
  }

  /**
   * 获取写锁
   *
   * 写锁是独占的，一次只能有一个写者
   *
   * @param key - 锁的键
   * @returns Disposable 对象，调用 dispose 释放锁
   *
   * @example
   * using lock = await Lock.write("file.ts")
   * // 写入文件...
   * // lock 会在作用域结束时自动释放
   */
  export async function write(key: string): Promise<Disposable> {
    const lock = get(key)

    return new Promise((resolve) => {
      if (!lock.writer && lock.readers === 0) {
        lock.writer = true
        resolve({
          [Symbol.dispose]: () => {
            lock.writer = false
            process(key)
          },
        })
      } else {
        lock.waitingWriters.push(() => {
          lock.writer = true
          resolve({
            [Symbol.dispose]: () => {
              lock.writer = false
              process(key)
            },
          })
        })
      }
    })
  }
}
