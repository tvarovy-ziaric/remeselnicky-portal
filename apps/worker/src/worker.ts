import { platformContract } from "@portal/contracts";
import { domainContract } from "@portal/domain";
import type { ObservabilityContext } from "@portal/config/server";

export interface WorkerRunResult {
  readonly apiVersion: string;
  readonly environment: ObservabilityContext["environment"];
  readonly releaseRevision: string;
  readonly service: "worker";
  readonly sharedDomainLoaded: boolean;
  readonly status: "ready";
}

export function runWorker(
  observability: ObservabilityContext,
): WorkerRunResult {
  return {
    apiVersion: platformContract.apiVersion,
    environment: observability.environment,
    releaseRevision: observability.releaseRevision,
    service: "worker",
    sharedDomainLoaded:
      domainContract.entityIdRepresentation === "opaque-string",
    status: "ready",
  };
}
