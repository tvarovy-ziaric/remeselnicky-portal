import type { SyntheticAccountFixture, SyntheticAccountKind } from "./model.js";

export type TestHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface TestHttpRequest {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: TestHttpMethod;
  readonly path: string;
}

export interface TestHttpResponse {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly statusCode: number;
}

export interface TestRequestTransport {
  execute(request: TestHttpRequest): Promise<TestHttpResponse>;
}

export interface AuthenticatedTestClient {
  readonly accountKind: SyntheticAccountKind;
  readonly synthetic: true;
  readonly userId: string;
  request(request: TestHttpRequest): Promise<TestHttpResponse>;
  toJSON(): Readonly<{
    accountKind: SyntheticAccountKind;
    authenticated: true;
    synthetic: true;
    userId: string;
  }>;
}

export type AuthenticatedTestClients = Readonly<
  Partial<Record<SyntheticAccountKind, AuthenticatedTestClient>>
>;

/**
 * Creates an in-process authenticated client without exposing the raw session
 * credential on the returned object, in JSON or in transport error messages.
 */
export function createAuthenticatedTestClient(input: {
  readonly fixture: SyntheticAccountFixture;
  readonly sessionCookieName: string;
  readonly sessionCookieValue: string;
  readonly transport: TestRequestTransport;
}): AuthenticatedTestClient {
  assertSyntheticFixture(input.fixture);
  assertCookiePart(input.sessionCookieName, "name", 1, 80);
  assertCookiePart(input.sessionCookieValue, "value", 16, 4096);
  const credentialHeader = `${input.sessionCookieName}=${input.sessionCookieValue}`;
  const identity = Object.freeze({
    accountKind: input.fixture.accountKind,
    authenticated: true as const,
    synthetic: true as const,
    userId: input.fixture.userId,
  });

  return Object.freeze({
    accountKind: identity.accountKind,
    synthetic: true as const,
    userId: identity.userId,
    async request(request: TestHttpRequest): Promise<TestHttpResponse> {
      assertRequest(request);
      const headers = normalizeHeaders(request.headers);
      if (headers.cookie !== undefined || headers.authorization !== undefined) {
        throw new Error(
          "Authenticated test requests cannot override authentication headers.",
        );
      }
      try {
        return await input.transport.execute({
          ...request,
          headers: Object.freeze({ ...headers, cookie: credentialHeader }),
        });
      } catch {
        // A transport/library error can contain a rendered request. Never let
        // it reflect the raw session credential into test logs.
        throw new Error("Authenticated test request transport failed.");
      }
    },
    toJSON: () => identity,
  });
}

export function createAuthenticatedTestClients(input: {
  readonly fixtures: readonly SyntheticAccountFixture[];
  readonly sessionCookieName: string;
  readonly sessionCookieValueFor: (fixture: SyntheticAccountFixture) => string;
  readonly transport: TestRequestTransport;
}): AuthenticatedTestClients {
  const clients: Partial<
    Record<SyntheticAccountKind, AuthenticatedTestClient>
  > = {};
  for (const fixture of input.fixtures) {
    if (clients[fixture.accountKind] !== undefined) {
      throw new Error(
        `Duplicate synthetic account kind: ${fixture.accountKind}`,
      );
    }
    clients[fixture.accountKind] = createAuthenticatedTestClient({
      fixture,
      sessionCookieName: input.sessionCookieName,
      sessionCookieValue: input.sessionCookieValueFor(fixture),
      transport: input.transport,
    });
  }
  return Object.freeze(clients);
}

function assertSyntheticFixture(fixture: SyntheticAccountFixture): void {
  if (fixture.synthetic !== true || fixture.analyticsActor.is_test !== true) {
    throw new TypeError(
      "Authenticated test clients require synthetic fixtures.",
    );
  }
}

function assertCookiePart(
  value: string,
  label: string,
  minimumLength: number,
  maximumLength: number,
): void {
  if (
    value.length < minimumLength ||
    value.length > maximumLength ||
    /[\s;,=\r\n]/u.test(value)
  ) {
    throw new TypeError(`Session cookie ${label} is malformed.`);
  }
}

function assertRequest(request: TestHttpRequest): void {
  if (!request.path.startsWith("/") || request.path.startsWith("//")) {
    throw new TypeError("Test request path must be application-relative.");
  }
}

function normalizeHeaders(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    result[name.toLowerCase()] = value;
  }
  return result;
}
