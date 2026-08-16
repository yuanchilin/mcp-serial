import type { Chunk, BufferStats, ReadResult } from "./types.js";

// ============================================================================
// 环形缓冲区 - 使用头索引避免 shift() O(n) 性能问题
// ============================================================================

export class RingBuffer {
  /** 数据块存储（永不从头部删除，仅移动 head 指针） */
  private chunks: Chunk[] = [];
  /** 第一个有效数据块的索引 */
  private head = 0;
  /** 缓冲区总字节数 */
  totalBytes = 0;
  /** Agent 读取游标 */
  agentReadOffset = 0;
  /** 缓冲区最大容量 */
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /** 追加数据到缓冲区 */
  append(text: string): void {
    if (!text) return;

    const chunk: Chunk = {
      timestamp: Date.now(),
      data: text,
      bytes: Buffer.byteLength(text, "utf-8"),
    };
    this.chunks.push(chunk);
    this.totalBytes += chunk.bytes;

    // 超过最大容量时从头裁剪（移动 head 指针）
    while (this.totalBytes > this.maxSize) {
      const removed = this.chunks[this.head];
      if (!removed) break;
      this.totalBytes -= removed.bytes;
      if (this.agentReadOffset > 0) {
        this.agentReadOffset = Math.max(0, this.agentReadOffset - removed.bytes);
      }
      this.head++;

      // 定期压缩：当 head 超过阈值时真正清除已移除的块
      if (this.head > 500) {
        this.chunks = this.chunks.slice(this.head);
        this.head = 0;
      }
    }
  }

  /** 获取从指定偏移量开始的所有数据（offset 和 newOffset 均为 UTF-8 字节） */
  getSince(offset: number): ReadResult {
    let text = "";
    let currentByteOffset = 0;

    for (let i = this.head; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const chunkEnd = currentByteOffset + chunk.bytes;
      if (chunkEnd > offset) {
        // 计算 chunk 内需要跳过的字节数
        const skipBytes = Math.max(0, offset - currentByteOffset);
        if (skipBytes >= chunk.bytes) {
          currentByteOffset = chunkEnd;
          continue;
        }
        // 按字节截断后解码，Buffer.toString 会自动跳过开头不完整的 UTF-8 字节
        const buf = Buffer.from(chunk.data, "utf-8");
        text += buf.subarray(skipBytes).toString("utf-8");
      }
      currentByteOffset = chunkEnd;
    }

    return { text, newOffset: this.totalBytes };
  }

  /** 获取全部数据（不更新偏移） */
  getAll(): string {
    let text = "";
    for (let i = this.head; i < this.chunks.length; i++) {
      text += this.chunks[i].data;
    }
    return text;
  }

  /** 获取缓冲区统计信息 */
  getStats(): BufferStats {
    return {
      totalBytes: this.totalBytes,
      chunkCount: this.chunks.length - this.head,
      bufferMaxSize: this.maxSize,
    };
  }

  /** 清空缓冲区 */
  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.totalBytes = 0;
    this.agentReadOffset = 0;
  }
}
