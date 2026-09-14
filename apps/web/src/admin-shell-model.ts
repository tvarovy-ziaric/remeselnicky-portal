export const ADMIN_MODULE_PRESENTATION = Object.freeze({
  audit: { icon: "AU", label: "Audit" },
  credentials: { icon: "DO", label: "Doklady" },
  dashboard: { icon: "PR", label: "Prehľad" },
  disputes: { icon: "SP", label: "Spory" },
  jobs: { icon: "ZÁ", label: "Zákazky" },
  profiles: { icon: "PF", label: "Profily" },
  reports: { icon: "HL", label: "Hlásenia" },
  users: { icon: "PO", label: "Používatelia" },
} as const);

export type AdminModuleId = keyof typeof ADMIN_MODULE_PRESENTATION;

export interface AdminConsoleModule {
  readonly description: string;
  readonly id: AdminModuleId;
  readonly label: string;
}

export function parseAdminModule(
  value: unknown,
  expectedId: string,
): AdminConsoleModule | undefined {
  if (
    !isRecord(value) ||
    value.state !== "PLACEHOLDER" ||
    typeof value.id !== "string" ||
    value.id !== expectedId ||
    !isAdminModuleId(value.id) ||
    typeof value.label !== "string" ||
    typeof value.description !== "string"
  ) {
    return undefined;
  }
  return {
    description: value.description,
    id: value.id,
    label: value.label,
  };
}

export interface AdminSessionView {
  readonly capabilities: readonly string[];
  readonly mfaAuthenticatedAt: string;
  readonly roles: readonly ("ADMIN" | "SUPER_ADMIN")[];
}

export function parseAdminSession(
  value: unknown,
): AdminSessionView | undefined {
  if (!isRecord(value)) return undefined;
  const { capabilities, mfaAuthenticatedAt, roles } = value;
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((item) => typeof item === "string") ||
    typeof mfaAuthenticatedAt !== "string" ||
    !Number.isFinite(Date.parse(mfaAuthenticatedAt)) ||
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every((role) => role === "ADMIN" || role === "SUPER_ADMIN") ||
    !capabilities.includes("admin.access")
  ) {
    return undefined;
  }
  return { capabilities, mfaAuthenticatedAt, roles };
}

export function parseAdminModules(
  value: unknown,
): readonly AdminConsoleModule[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.modules)) return undefined;
  const parsed: AdminConsoleModule[] = [];
  const seen = new Set<string>();
  for (const item of value.modules) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !isAdminModuleId(item.id) ||
      typeof item.label !== "string" ||
      typeof item.description !== "string" ||
      seen.has(item.id)
    ) {
      return undefined;
    }
    seen.add(item.id);
    parsed.push({
      description: item.description,
      id: item.id,
      label: item.label,
    });
  }
  return parsed;
}

export function isAdminModuleId(value: string): value is AdminModuleId {
  return Object.hasOwn(ADMIN_MODULE_PRESENTATION, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
