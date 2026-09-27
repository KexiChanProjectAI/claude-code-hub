import type { UpstreamQuotaProbeOptions } from "@/types/upstream-quota";

/**
 * Build the persisted probe options from form inputs.
 * Returns null when nothing is set so the column stays empty.
 * A project id is only meaningful together with an organization id.
 */
export function buildUpstreamQuotaProbeOptions(
  zhipuOrganization: string | null | undefined,
  zhipuProject: string | null | undefined
): UpstreamQuotaProbeOptions | null {
  const organization = zhipuOrganization?.trim() ?? "";
  const project = zhipuProject?.trim() ?? "";
  if (!organization) return null;
  return project
    ? { zhipuOrganization: organization, zhipuProject: project }
    : { zhipuOrganization: organization };
}
