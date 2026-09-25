import type { AdminCapability } from "@portal/admin-auth";

export const ADMIN_CONSOLE_BASE_PATH = "/v1/admin/console";

export const ADMIN_CONSOLE_MODULES = Object.freeze({
  audit: Object.freeze({
    capability: "admin.sensitive.read" as const,
    description: "Nemenná história privilegovaných operácií.",
    label: "Audit",
  }),
  credentials: Object.freeze({
    capability: "admin.credentials.review" as const,
    description: "Fronta dokladov a profesijných oprávnení.",
    label: "Doklady",
  }),
  dashboard: Object.freeze({
    capability: "admin.access" as const,
    description: "Prevádzkové fronty Web Alpha.",
    label: "Prehľad",
  }),
  disputes: Object.freeze({
    capability: "admin.disputes.manage" as const,
    description: "Otvorené prípady a spory.",
    label: "Spory",
  }),
  jobs: Object.freeze({
    capability: "admin.jobs.correct" as const,
    description: "Problémové zákazky a ich história.",
    label: "Zákazky",
  }),
  profiles: Object.freeze({
    capability: "admin.profiles.review" as const,
    description: "Profily čakajúce na prvé schválenie.",
    label: "Profily",
  }),
  privacy: Object.freeze({
    capability: "admin.privacy.manage" as const,
    description: "Žiadosti dotknutých osôb a uzavretie účtov.",
    label: "Súkromie",
  }),
  reports: Object.freeze({
    capability: "admin.reviews.moderate" as const,
    description: "Nahlásený obsah pripravený na posúdenie.",
    label: "Hlásenia",
  }),
  users: Object.freeze({
    capability: "admin.users.manage" as const,
    description: "Obmedzené a pozastavené účty.",
    label: "Používatelia",
  }),
} satisfies Readonly<
  Record<
    string,
    {
      readonly capability: AdminCapability;
      readonly description: string;
      readonly label: string;
    }
  >
>);

export type AdminConsoleModuleId = keyof typeof ADMIN_CONSOLE_MODULES;

export function isAdminConsoleModuleId(
  value: string,
): value is AdminConsoleModuleId {
  return Object.hasOwn(ADMIN_CONSOLE_MODULES, value);
}
