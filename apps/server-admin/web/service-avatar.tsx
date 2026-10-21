import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ServiceIconResponse,
  ServiceUrl,
  type Service,
} from "../../../packages/protocol/service-catalog";
import { api } from "./lib/api";
import { useAdmin } from "./context";
import { ServiceGlyph, type CatalogState } from "./catalog-shared";
import { EntityIcon } from "@admin/components/console/entity-icon";

export function ServiceAvatar({
  service,
  state,
  size = "md",
}: {
  service: Pick<Service, "url" | "icon" | "iconSource"> & { id?: string };
  state: CatalogState;
  size?: "sm" | "md" | "lg";
}) {
  const { data } = useAdmin();
  const [settledUrl, setSettledUrl] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettledUrl(service.url), 500);
    return () => clearTimeout(timer);
  }, [service.url]);
  const query = useQuery({
    queryKey: [
      "admin",
      "favicon",
      data.authentication.principalId,
      state.target.organizationId,
      state.target.workspaceId,
      service.id ?? null,
      service.url,
    ],
    queryFn: async ({ signal }) =>
      ServiceIconResponse.parse(
        await api(
          "identity/catalog/icon",
          {
            ...state.target,
            ...(service.id ? { serviceId: service.id } : { url: service.url }),
          },
          signal,
        ),
      ),
    enabled:
      service.iconSource === "favicon" &&
      state.scope.ready &&
      ServiceUrl.safeParse(service.url).success &&
      (service.id !== undefined || settledUrl === service.url),
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const source = service.iconSource === "favicon" ? query.data?.dataUrl : null;
  const [failed, setFailed] = useState<string | null>(null);
  return source && failed !== source ? (
    <EntityIcon size={size} tone="image">
      <img src={source} alt="" onError={() => setFailed(source)} />
    </EntityIcon>
  ) : (
    <ServiceGlyph icon={service.icon} size={size} />
  );
}
