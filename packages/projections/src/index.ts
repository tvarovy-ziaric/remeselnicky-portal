import type { AuthorizationDecision } from "@portal/authorization";

export const PROJECTION_AUDIENCES = Object.freeze([
  "PUBLIC",
  "PRIVATE",
  "CONFIRMED_CONTACT",
  "CONFIRMED_ADDRESS",
  "ADMIN_SENSITIVE",
  "ADMIN_INTERNAL",
] as const);

export type ProjectionAudience = (typeof PROJECTION_AUDIENCES)[number];
export type ProjectionValue =
  | boolean
  | number
  | string
  | null
  | readonly ProjectionValue[]
  | ProjectionObject;
export interface ProjectionObject {
  readonly [key: string]: ProjectionValue | undefined;
}

export interface ProjectionField<Source extends object> {
  readonly audience: ProjectionAudience;
  readonly project: (source: Readonly<Source>) => ProjectionValue | undefined;
}

export type ProjectionPlan<Source extends object> = Readonly<
  Record<string, ProjectionField<Source>>
>;

const trustedView = Symbol("portal.projections.trusted-view");
const fieldName = /^[a-z][A-Za-z0-9]*$/u;

export type ContextualProjectionGrant = "CONTACT" | "EXACT_ADDRESS";
export type AdminProjectionCapability = "SENSITIVE_DATA" | "INTERNAL_NOTES";

export type ProjectionView =
  | { readonly kind: "PUBLIC"; readonly [trustedView]: true }
  | { readonly kind: "PRIVATE"; readonly [trustedView]: true }
  | {
      readonly grants: readonly ContextualProjectionGrant[];
      readonly kind: "CONTEXTUAL";
      readonly [trustedView]: true;
    }
  | {
      readonly capabilities: readonly AdminProjectionCapability[];
      readonly kind: "ADMIN";
      readonly [trustedView]: true;
    };

export const publicProjectionView: ProjectionView = Object.freeze({
  kind: "PUBLIC",
  [trustedView]: true as const,
});

export class ProjectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

export function defineProjectionPlan<Source extends object>(
  fields: ProjectionPlan<Source>,
): ProjectionPlan<Source> {
  const entries = Object.entries(fields);
  for (const [name, field] of entries) {
    if (!fieldName.test(name)) {
      throw new ProjectionError(
        "Projection fields must use stable camelCase identifiers",
      );
    }
    if (!PROJECTION_AUDIENCES.includes(field.audience)) {
      throw new ProjectionError("Projection field has an unknown audience");
    }
    assertSensitiveFieldAudience(name, field.audience);
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(([name, field]) => [name, Object.freeze(field)]),
    ),
  );
}

export function createPrivateProjectionView(
  decision: AuthorizationDecision,
): ProjectionView {
  requirePermit(decision);
  return Object.freeze({ kind: "PRIVATE", [trustedView]: true as const });
}

export function createContextualProjectionView(
  decision: AuthorizationDecision,
  grants: readonly ContextualProjectionGrant[],
): ProjectionView {
  requirePermit(decision);
  return Object.freeze({
    grants: Object.freeze([...new Set(grants)]),
    kind: "CONTEXTUAL",
    [trustedView]: true as const,
  });
}

export function createAdminProjectionView(
  decision: AuthorizationDecision,
  capabilities: readonly AdminProjectionCapability[],
): ProjectionView {
  requirePermit(decision);
  return Object.freeze({
    capabilities: Object.freeze([...new Set(capabilities)]),
    kind: "ADMIN",
    [trustedView]: true as const,
  });
}

export function projectResponse<Source extends object>(
  plan: ProjectionPlan<Source>,
  source: Readonly<Source>,
  view: ProjectionView,
): Readonly<ProjectionObject> {
  if (!isTrustedView(view)) {
    throw new ProjectionError(
      "A server-authorized projection view is required",
    );
  }

  const response: Record<string, ProjectionValue> = Object.create(
    null,
  ) as Record<string, ProjectionValue>;
  try {
    for (const [name, field] of Object.entries(plan)) {
      if (!isAudienceVisible(field.audience, view)) continue;
      const value = field.project(source);
      if (value !== undefined) response[name] = value;
    }
  } catch {
    throw new ProjectionError("Response projection failed");
  }

  return Object.freeze(response);
}

function requirePermit(decision: AuthorizationDecision): void {
  if (decision.effect !== "PERMIT") {
    throw new ProjectionError("Projection access denied");
  }
}

function isTrustedView(view: ProjectionView): boolean {
  return (
    typeof view === "object" && view !== null && view[trustedView] === true
  );
}

function isAudienceVisible(
  audience: ProjectionAudience,
  view: ProjectionView,
): boolean {
  if (audience === "PUBLIC") return true;
  if (view.kind === "PUBLIC") return false;
  if (view.kind === "PRIVATE") {
    return (
      audience === "PRIVATE" ||
      audience === "CONFIRMED_CONTACT" ||
      audience === "CONFIRMED_ADDRESS"
    );
  }
  if (view.kind === "CONTEXTUAL") {
    return (
      (audience === "CONFIRMED_CONTACT" && view.grants.includes("CONTACT")) ||
      (audience === "CONFIRMED_ADDRESS" &&
        view.grants.includes("EXACT_ADDRESS"))
    );
  }
  return (
    (view.capabilities.includes("SENSITIVE_DATA") &&
      (audience === "PRIVATE" ||
        audience === "CONFIRMED_CONTACT" ||
        audience === "CONFIRMED_ADDRESS" ||
        audience === "ADMIN_SENSITIVE")) ||
    (audience === "ADMIN_INTERNAL" &&
      view.capabilities.includes("INTERNAL_NOTES"))
  );
}

function assertSensitiveFieldAudience(
  name: string,
  audience: ProjectionAudience,
): void {
  const normalized = name.toLowerCase();
  const contactOrAddress =
    /email|phone|telephone|mobile|exactaddress|streetaddress|house(number)?/u.test(
      normalized,
    );
  const internal = /internalnote|riskflag|fraudflag|moderationnote/u.test(
    normalized,
  );

  if (contactOrAddress && audience === "PUBLIC") {
    throw new ProjectionError(
      "Contact and exact-address fields cannot be public",
    );
  }
  if (internal && audience !== "ADMIN_INTERNAL") {
    throw new ProjectionError(
      "Internal notes and risk flags require the admin-internal audience",
    );
  }
}
