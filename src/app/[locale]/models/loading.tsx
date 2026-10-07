import { TableSkeleton } from "@/components/loading/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function ModelsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-9 w-64" />
      <div className="rounded-xl border bg-card p-4">
        <TableSkeleton rows={8} columns={7} />
      </div>
    </div>
  );
}
