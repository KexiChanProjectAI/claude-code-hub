import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ANTHROPIC_EFFORT_BADGE_STYLES: Record<string, string> = {
  low: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300",
  medium:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300",
  high: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300",
  max: "border-red-300 bg-red-100 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200",
};

const DEFAULT_BADGE_STYLE =
  "border-muted-foreground/20 bg-muted/40 text-muted-foreground dark:border-muted-foreground/30 dark:bg-muted/20";

function getAnthropicEffortBadgeClassName(effort: string): string {
  return ANTHROPIC_EFFORT_BADGE_STYLES[effort.trim().toLowerCase()] ?? DEFAULT_BADGE_STYLE;
}

interface AnthropicEffortBadgeProps {
  effort: string;
  label: string;
  className?: string;
}

export function AnthropicEffortBadge({ effort, label, className }: AnthropicEffortBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "w-fit px-1 text-[10px] leading-tight whitespace-nowrap",
        getAnthropicEffortBadgeClassName(effort),
        className
      )}
    >
      {label}
    </Badge>
  );
}
