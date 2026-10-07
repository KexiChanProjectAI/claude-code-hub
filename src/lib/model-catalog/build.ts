import { getAvailableModelsGroupedByProviderType } from "@/app/v1/_lib/models/available-models";
import { getCachedSystemSettings } from "@/lib/config/system-settings-cache";
import { logger } from "@/lib/logger";
import { vendorDisplayName } from "@/lib/model-vendor/vendor-inference";
import { getCloudPricingCatalog } from "@/repository/cloud-pricing-catalog";
import { buildCatalogCacheKey, type CachedCatalog, getOrBuildCatalog } from "./cache";
import { toCatalogMetadata } from "./metadata";
import { resolvePricesForModels } from "./price-join";
import {
  ALL_CATALOG_PROVIDER_TYPES,
  CATALOG_PROTOCOLS,
  protocolForProviderType,
} from "./protocols";
import type {
  CatalogAuthState,
  CatalogModel,
  CatalogProtocol,
  CatalogProtocolId,
  ModelCatalog,
} from "./types";

const PROTOCOL_ORDER = new Map(CATALOG_PROTOCOLS.map((protocol, index) => [protocol.id, index]));

function sortProtocols(ids: Iterable<CatalogProtocolId>): CatalogProtocolId[] {
  return [...ids].sort((a, b) => (PROTOCOL_ORDER.get(a) ?? 0) - (PROTOCOL_ORDER.get(b) ?? 0));
}

async function loadVendorDirectory(): Promise<
  Map<string, { name: string; icon: string | null; iconMono: boolean }>
> {
  const directory = new Map<string, { name: string; icon: string | null; iconMono: boolean }>();
  try {
    const catalog = await getCloudPricingCatalog();
    for (const entry of catalog?.vendors ?? []) {
      if (!entry?.vendor) continue;
      directory.set(entry.vendor, {
        name: entry.name || vendorDisplayName(entry.vendor),
        icon: entry.icon ?? null,
        iconMono: entry.iconMono === true,
      });
    }
  } catch (error) {
    logger.warn("[ModelCatalog] Failed to load vendor directory", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return directory;
}

async function computeCatalog(auth: CatalogAuthState): Promise<CachedCatalog> {
  const { groups } = await getAvailableModelsGroupedByProviderType(
    auth,
    ALL_CATALOG_PROVIDER_TYPES
  );

  const protocolsByModel = new Map<string, Set<CatalogProtocolId>>();
  const displayNameByModel = new Map<string, string | undefined>();
  for (const group of groups) {
    const protocol = protocolForProviderType(group.providerType);
    if (!protocol) continue;
    for (const model of group.models) {
      let set = protocolsByModel.get(model.id);
      if (!set) {
        set = new Set();
        protocolsByModel.set(model.id, set);
      }
      set.add(protocol);
      if (!displayNameByModel.get(model.id) && model.displayName) {
        displayNameByModel.set(model.id, model.displayName);
      }
    }
  }

  const ids = [...protocolsByModel.keys()].sort((a, b) => a.localeCompare(b));
  const [prices, vendors] = await Promise.all([resolvePricesForModels(ids), loadVendorDirectory()]);

  const models: CatalogModel[] = ids.map((id) => {
    const metadata = toCatalogMetadata(prices.get(id)?.priceData ?? null, {
      id,
      displayName: displayNameByModel.get(id),
    });
    const vendorEntry = metadata.vendor ? vendors.get(metadata.vendor) : undefined;
    return {
      id,
      ...metadata,
      vendorName: metadata.vendor
        ? (vendorEntry?.name ?? vendorDisplayName(metadata.vendor))
        : null,
      vendorIcon: metadata.vendorIcon ?? vendorEntry?.icon ?? null,
      vendorIconMono: metadata.vendorIcon
        ? metadata.vendorIconMono
        : vendorEntry?.iconMono === true,
      protocols: sortProtocols(protocolsByModel.get(id) ?? []),
    };
  });

  const protocols: CatalogProtocol[] = CATALOG_PROTOCOLS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    endpointPath: definition.endpointPath,
    models: models
      .filter((model) => model.protocols.includes(definition.id))
      .map((model) => model.id),
  }));

  return { generatedAt: new Date().toISOString(), models, protocols };
}

async function loadNotes(): Promise<string | null> {
  try {
    const settings = await getCachedSystemSettings();
    const notes = settings.agentCatalogNotes?.trim();
    return notes ? notes : null;
  } catch (error) {
    logger.warn("[ModelCatalog] Failed to load agent catalog notes", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Build the catalog of models visible to one API key.
 *
 * The model/protocol part is cached per (effective provider group, user allowedModels) for 60s.
 * Admin notes are attached on every call so edits show up right away.
 */
export async function buildModelCatalog(auth: CatalogAuthState): Promise<ModelCatalog> {
  const [catalog, notes] = await Promise.all([
    getOrBuildCatalog(buildCatalogCacheKey(auth), () => computeCatalog(auth)),
    loadNotes(),
  ]);
  return { ...catalog, notes };
}
