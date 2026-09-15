import {
  createServerMediaEntityAccess,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
} from "./delivery.js";
import type { MediaUploadPurpose } from "./model.js";

export function createPurposeBoundMediaEntityAccessResolver(input: {
  readonly byPurpose: Readonly<
    Partial<Record<MediaUploadPurpose, MediaEntityAccessResolver>>
  >;
}): MediaEntityAccessResolver {
  const entries = Object.entries(input.byPurpose);
  const byPurpose = new Map<MediaUploadPurpose, MediaEntityAccessResolver>();
  for (const [purpose, resolver] of entries) {
    if (resolver !== undefined) {
      byPurpose.set(purpose as MediaUploadPurpose, resolver);
    }
  }
  return Object.freeze({
    resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      const resolver = byPurpose.get(snapshot.asset.purpose);
      if (resolver !== undefined) {
        return resolver.resolvePrivateMediaAccess(snapshot);
      }
      return Promise.resolve(
        createServerMediaEntityAccess({
          revision: `unsupported:${snapshot.asset.purpose}`,
        }),
      );
    },
  });
}
