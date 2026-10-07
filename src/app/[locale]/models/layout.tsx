import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { DashboardHeader } from "../dashboard/_components/dashboard-header";

type ModelsParams = { locale: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<ModelsParams>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "modelCatalog" });
  return { title: t("pageTitle"), description: t("pageDescription") };
}

/**
 * Model catalog layout. Any signed-in session works (admin, web UI key or read-only key);
 * the catalog is always scoped to the session's own user and key.
 */
export default async function ModelsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<ModelsParams>;
}) {
  const { locale } = await params;
  const session = await getSession({ allowReadOnlyAccess: true });

  if (!session) {
    return redirect({ href: "/login?from=/models", locale });
  }

  return (
    <div className="min-h-[var(--cch-viewport-height,100vh)] bg-background">
      <DashboardHeader session={session} locale={locale} />
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
