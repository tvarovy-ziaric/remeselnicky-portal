import { z } from "zod";

export const deploymentEnvironmentSchema = z.enum([
  "development",
  "staging",
  "production",
]);

export type DeploymentEnvironment = z.infer<typeof deploymentEnvironmentSchema>;

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_APP_ENV: deploymentEnvironmentSchema,
  NEXT_PUBLIC_RELEASE_REVISION: z.string().trim().min(1),
});

export interface PublicConfig {
  readonly environment: DeploymentEnvironment;
  readonly releaseRevision: string;
}

/**
 * Parses only values that are intentionally safe to embed in a browser bundle.
 * Unknown keys are discarded so passing a larger environment object cannot add
 * an accidental public field.
 */
export function parsePublicConfig(
  environment: Readonly<Record<string, unknown>>,
): PublicConfig {
  const parsed = publicEnvironmentSchema.parse(environment);

  return Object.freeze({
    environment: parsed.NEXT_PUBLIC_APP_ENV,
    releaseRevision: parsed.NEXT_PUBLIC_RELEASE_REVISION,
  });
}
