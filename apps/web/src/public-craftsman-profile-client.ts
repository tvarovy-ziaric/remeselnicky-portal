import {
  serializePublicCraftsmanProfile,
  type PublicCraftsmanProfile,
  type PublicCraftsmanProfileCandidate,
} from "@portal/domain";
import { cache } from "react";

interface PublicProfileLoaderDependencies {
  readonly apiOrigin: string;
  readonly fetch: typeof fetch;
}

export function createPublicCraftsmanProfileLoader(
  dependencies: PublicProfileLoaderDependencies,
) {
  const origin = internalApiOrigin(dependencies.apiOrigin);
  return async (profileId: string): Promise<PublicCraftsmanProfile | null> => {
    if (origin === null) return null;
    try {
      const endpoint = new URL(
        `/v1/public/craftsmen/${encodeURIComponent(profileId)}`,
        origin,
      );
      const response = await dependencies.fetch(endpoint, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return null;
      const candidate =
        (await response.json()) as PublicCraftsmanProfileCandidate;
      return serializePublicCraftsmanProfile(candidate);
    } catch {
      return null;
    }
  };
}

const loadProfile = createPublicCraftsmanProfileLoader({
  apiOrigin: process.env.PORTAL_API_ORIGIN ?? "http://127.0.0.1:3001",
  fetch,
});

/** Request-memoized so metadata and page body use one no-store public snapshot. */
export const loadPublicCraftsmanProfile = cache(loadProfile);

function internalApiOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
