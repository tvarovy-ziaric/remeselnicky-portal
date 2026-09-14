import { assertUniformNotFound } from "./authorization-harness.js";
import type {
  AuthenticatedTestClient,
  AuthenticatedTestClients,
  TestHttpResponse,
  TestRequestTransport,
} from "./http.js";
import type { SyntheticAccountKind } from "./model.js";

export interface PrivateFileIdorFixture {
  readonly allowedAccountKinds: readonly SyntheticAccountKind[];
  readonly deniedAccountKinds: readonly SyntheticAccountKind[];
  readonly mediaAssetId: string;
  readonly ownerUserId: string;
  readonly privateStorageKey: string;
  readonly provenanceEntityId: string;
  readonly requestPath: string;
  readonly synthetic: true;
}

export function createPrivateFileIdorFixture(): PrivateFileIdorFixture {
  return Object.freeze({
    allowedAccountKinds: Object.freeze([
      "CUSTOMER",
      "CRAFTSMAN_INDIVIDUAL",
    ] as const),
    deniedAccountKinds: Object.freeze([
      "CRAFTSMAN_COMPANY",
      "COMBINED",
      "ADMIN",
      "SUPERADMIN",
      "SUSPENDED",
    ] as const),
    mediaAssetId: "00000000-0000-4000-8000-000000000321",
    ownerUserId: "00000000-0000-4000-8000-000000000101",
    privateStorageKey: "private/2026/01/00000000-0000-4000-8000-000000000321",
    provenanceEntityId: "00000000-0000-4000-8000-000000000322",
    requestPath: "/v1/media/00000000-0000-4000-8000-000000000321/download",
    synthetic: true as const,
  });
}

/**
 * Exercises the negative half of the private-file boundary. The caller seeds
 * the fixture and configures only CRAFTSMAN_INDIVIDUAL as an invited provider.
 */
export async function verifyPrivateFileIdorDenials(input: {
  readonly anonymousTransport: TestRequestTransport;
  readonly clients: AuthenticatedTestClients;
  readonly fixture?: PrivateFileIdorFixture;
}): Promise<readonly TestHttpResponse[]> {
  const fixture = input.fixture ?? createPrivateFileIdorFixture();
  const requests: Promise<TestHttpResponse>[] = [
    input.anonymousTransport.execute({
      method: "GET",
      path: fixture.requestPath,
    }),
  ];
  for (const accountKind of fixture.deniedAccountKinds) {
    const client = requiredClient(input.clients, accountKind);
    requests.push(client.request({ method: "GET", path: fixture.requestPath }));
  }
  const responses = await Promise.all(requests);
  assertUniformNotFound(responses, {
    forbiddenResponseMarkers: [
      fixture.privateStorageKey,
      fixture.provenanceEntityId,
      fixture.ownerUserId,
    ],
  });
  return Object.freeze(responses);
}

function requiredClient(
  clients: AuthenticatedTestClients,
  kind: SyntheticAccountKind,
): AuthenticatedTestClient {
  const client = clients[kind];
  if (client === undefined) {
    throw new Error(`Missing authenticated client for ${kind}.`);
  }
  return client;
}
