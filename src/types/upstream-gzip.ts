/**
 * 出站 gzip 能力观测（供应商页面展示用）。
 *
 * - request：上游能否解压 gzip 请求体（由压缩请求成功 / 明文回退成功学习得出）
 * - response：声明 accept-encoding: gzip 后，上游是否实际返回了 gzip 响应
 */
export type UpstreamGzipRequestState = "supported" | "unsupported" | "unknown" | "disabled";
export type UpstreamGzipResponseState = "compressed" | "uncompressed" | "unknown" | "disabled";

export interface UpstreamGzipObservation<TState extends string> {
  state: TState;
  /** 最近一次状态变化的时间戳（ms），无观测时为 null */
  updatedAt: number | null;
}

export interface ProviderUpstreamGzipStatus {
  request: UpstreamGzipObservation<UpstreamGzipRequestState>;
  response: UpstreamGzipObservation<UpstreamGzipResponseState>;
}

export type ProviderUpstreamGzipStatusMap = Record<number, ProviderUpstreamGzipStatus>;

/** 单个方向的持久化记录（Redis / 进程内快照共用） */
export interface UpstreamGzipRecord {
  request?: { state: "supported" | "unsupported"; updatedAt: number };
  response?: { state: "compressed" | "uncompressed"; updatedAt: number };
}
