#!/usr/bin/env node

// ============================================================================
// 共享类型定义
// ============================================================================

/** 环形缓冲区中的数据块 */
export interface Chunk {
  timestamp: number;
  data: string;
}

/** 缓冲区统计信息 */
export interface BufferStats {
  totalBytes: number;
  chunkCount: number;
  bufferMaxSize: number;
}

/** 串口连接状态 */
export interface SerialStatus {
  connected: boolean;
  port: string;
  baudRate: number;
  startedAt: string | null;
  uptimeMs: number;
  stats: BufferStats;
}

/** 从偏移量读取的结果 */
export interface ReadResult {
  text: string;
  newOffset: number;
}

/** HTTP POST /send 请求体 */
export interface SendRequestBody {
  command: string;
  lineEnding?: string;
}

/** SSE 事件数据 */
export interface SSEEventData {
  timestamp: number;
  text: string;
}
