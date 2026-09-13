import {
  createAuthorizationEvaluator,
  createServerAuthorizationContext,
  defineAuthorizationPolicy,
  denyAuthorization,
  permitAuthorization,
  resolveAuthorizationTarget,
  unresolvedAuthorizationTarget,
  type AuthorizationActor,
} from "@portal/authorization";

import type { MediaUploadPurpose } from "./model.js";

interface MediaUploadTarget {
  readonly ownerUserId: string;
  readonly uploaderUserId: string;
}

interface MediaUploadContext {
  readonly purpose: MediaUploadPurpose;
}

const mediaUploadPolicy = defineAuthorizationPolicy<
  "media_asset",
  "upload",
  MediaUploadTarget,
  MediaUploadContext
>({
  accountRequirement: "ACTIVE",
  action: "upload",
  resource: "media_asset",
  evaluate({ actor, target }) {
    return actor.userId === target.ownerUserId &&
      actor.userId === target.uploaderUserId
      ? permitAuthorization()
      : denyAuthorization();
  },
});

const mediaAuthorization = createAuthorizationEvaluator([mediaUploadPolicy]);

export async function authorizeMediaUpload(
  actor: AuthorizationActor,
  purpose: MediaUploadPurpose,
): Promise<boolean> {
  const actorUserId = actor.kind === "AUTHENTICATED" ? actor.userId : null;
  const target =
    actorUserId === null
      ? unresolvedAuthorizationTarget()
      : resolveAuthorizationTarget({
          ownerUserId: actorUserId,
          uploaderUserId: actorUserId,
        });
  const decision = await mediaAuthorization.authorize(mediaUploadPolicy, {
    actor,
    context: createServerAuthorizationContext({ purpose }),
    target,
  });
  return decision.effect === "PERMIT";
}
