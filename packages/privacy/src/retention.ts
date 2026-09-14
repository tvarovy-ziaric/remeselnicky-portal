import type {
  PrivacyRepository,
  RetentionCategory,
  RetentionPolicyVersion,
} from "./model.js";

export class RetentionPolicyUnresolvedError extends Error {
  override readonly name = "RetentionPolicyUnresolvedError";
}

/**
 * This is the only gate cleanup workers should call. It returns no rule until
 * a concrete duration has both legal approval and launch readiness.
 */
export async function requireExecutableRetentionPolicy(
  repository: Pick<PrivacyRepository, "findLatestRetentionPolicy">,
  category: RetentionCategory,
): Promise<RetentionPolicyVersion & { readonly durationDays: number }> {
  const policy = await repository.findLatestRetentionPolicy(category);
  if (
    policy === null ||
    policy.legalReviewState !== "APPROVED" ||
    policy.launchState !== "READY" ||
    policy.durationDays === null ||
    !Number.isSafeInteger(policy.durationDays) ||
    policy.durationDays < 1
  ) {
    throw new RetentionPolicyUnresolvedError(
      `Retention policy is unresolved for ${category}`,
    );
  }
  return Object.freeze({ ...policy, durationDays: policy.durationDays });
}
