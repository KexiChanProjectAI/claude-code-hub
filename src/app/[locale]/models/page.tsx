import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { buildModelCatalog } from "@/lib/model-catalog";
import { AgentNotes } from "./_components/agent-notes";
import { ModelCatalogView } from "./_components/model-catalog-view";

export const dynamic = "force-dynamic";

async function resolveOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return `${proto === "http" || proto === "https" ? proto : "https"}://${host}`;
}

export default async function ModelsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await getSession({ allowReadOnlyAccess: true });
  if (!session) {
    return redirect({ href: "/login?from=/models", locale });
  }

  const [catalog, origin, t] = await Promise.all([
    buildModelCatalog({ user: session.user, key: session.key }),
    resolveOrigin(),
    getTranslations({ locale, namespace: "modelCatalog" }),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold leading-tight">{t("pageTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("pageDescription")}</p>
      </div>
      <ModelCatalogView catalog={catalog} origin={origin} />
      <AgentNotes markdown={catalog.notes} title={t("notes.title")} />
    </div>
  );
}
