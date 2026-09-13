import { platformContract } from "@portal/contracts";
import { domainContract } from "@portal/domain";

export interface WorkerRunResult {
  readonly apiVersion: string;
  readonly service: "worker";
  readonly sharedDomainLoaded: boolean;
  readonly status: "ready";
}

export function runWorker(): WorkerRunResult {
  return {
    apiVersion: platformContract.apiVersion,
    service: "worker",
    sharedDomainLoaded:
      domainContract.entityIdRepresentation === "opaque-string",
    status: "ready",
  };
}
