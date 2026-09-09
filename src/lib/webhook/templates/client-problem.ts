import type { ClientProblemAlertData, StructuredMessage } from "../types";
import { formatDateTime } from "../utils/date";

export function buildClientProblemMessage(
  data: ClientProblemAlertData,
  timezone?: string
): StructuredMessage {
  const tz = timezone || "UTC";
  const isCyber = data.bucket === "cyber";

  const fieldItems = isCyber
    ? [
        { label: "Cyber risk", value: String(data.kindCounts.cyber) },
        { label: "窗口开始", value: formatDateTime(data.windowStartedAt, tz) },
      ]
    : [
        { label: "超时", value: String(data.kindCounts.timeout) },
        { label: "服务端错误", value: String(data.kindCounts.server) },
        { label: "窗口开始", value: formatDateTime(data.windowStartedAt, tz) },
      ];

  const listSections = [
    { title: "状态码", items: data.byStatus },
    { title: "供应商", items: data.byProvider },
    { title: "用户", items: data.byUser },
    { title: "模型", items: data.byModel },
  ]
    .filter((section) => section.items.length > 0)
    .map((section) => ({
      title: section.title,
      content: [
        {
          type: "text" as const,
          value: section.items.map((item) => `${item.key} · ${item.count} 次`).join("\n"),
        },
      ],
    }));

  const sampleSection =
    data.samples.length > 0
      ? [
          {
            title: "最近样本",
            content: [
              {
                type: "list" as const,
                style: "bullet" as const,
                items: data.samples.slice(0, 10).map((sample) => ({
                  primary: `${sample.userName} / ${sample.providerName} / ${sample.model} / ${sample.statusCode} / ${sample.kind}: ${sample.error}`,
                })),
              },
            ],
          },
        ]
      : [];

  return {
    header: {
      title: isCyber ? "Cyber risk 汇总" : "客户端故障汇总",
      icon: isCyber ? "[CYBER]" : "[ERR]",
      level: "error",
    },
    sections: [
      {
        content: [
          {
            type: "quote",
            value: `过去 ${data.windowMinutes} 分钟累计 ${data.totalCount} 条，触发条件：${data.trigger === "count" ? "条数阈值" : "时间窗口"}`,
          },
        ],
      },
      {
        content: [
          {
            type: "fields",
            items: fieldItems,
          },
        ],
      },
      ...listSections,
      ...sampleSection,
    ],
    timestamp: new Date(),
  };
}
