import type { EventPayload } from "@portal/outbox";

export const NOTIFICATION_CATEGORIES = [
  "CHAT",
  "MARKETPLACE",
  "JOB_OPERATIONS",
  "REVIEWS",
  "ACCOUNT_SECURITY",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface NotificationPolicy {
  readonly category: NotificationCategory;
  /** A requested email delivery ignores an opt-out when this is true. */
  readonly emailRequired: boolean;
}

export interface NotificationPresentation extends NotificationPolicy {
  readonly body: string;
  readonly title: string;
}

type CatalogEntry = Readonly<
  NotificationPresentation & {
    readonly bodyForPayload?: (payload: EventPayload) => string;
  }
>;

const MARKETPLACE_REQUIRED = policy("MARKETPLACE", true);
const MARKETPLACE_OPTIONAL = policy("MARKETPLACE", false);
const JOB_REQUIRED = policy("JOB_OPERATIONS", true);
const JOB_OPTIONAL = policy("JOB_OPERATIONS", false);
const REVIEW_OPTIONAL = policy("REVIEWS", false);
const SECURITY_REQUIRED = policy("ACCOUNT_SECURITY", true);
const SECURITY_OPTIONAL = policy("ACCOUNT_SECURITY", false);

const CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze({
  "conversation.message_received": entry(
    "Nová správa",
    "V konverzácii máte novú správu.",
    policy("CHAT", false),
  ),
  "credential.approved": entry(
    "Doklad bol schválený",
    "Overenie vášho profesijného dokladu bolo schválené.",
    SECURITY_OPTIONAL,
  ),
  "credential.rejected": entry(
    "Doklad nebol schválený",
    "Overenie dokladu bolo zamietnuté. Bezpečný dôvod nájdete v detaile.",
    SECURITY_OPTIONAL,
  ),
  "credential.revoked": entry(
    "Platnosť dokladu bola odobratá",
    "Overenie profesijného dokladu už nie je platné. Skontrolujte ďalší postup.",
    SECURITY_REQUIRED,
  ),
  "job.cancelled": entry(
    "Zákazka bola zrušená",
    "Stav zákazky sa zmenil na zrušenú.",
    JOB_REQUIRED,
  ),
  "job.cancelled.admin_forced": entry(
    "Administratívne zrušenie zákazky",
    "Zákazka bola z bezpečnostného alebo prevádzkového dôvodu zrušená administrátorom.",
    JOB_REQUIRED,
  ),
  "job.change_order.approved": entry(
    "Zmena zákazky bola schválená",
    "Schválená revízia zmeny je dostupná v detaile zákazky.",
    JOB_REQUIRED,
  ),
  "job.change_order.counterproposed": entry(
    "Nová revízia zmeny zákazky",
    "Protistrana navrhla novú revíziu zmeny. Vyžaduje si vašu pozornosť.",
    JOB_REQUIRED,
  ),
  "job.change_order.proposed": entry(
    "Navrhnutá zmena zákazky",
    "Protistrana navrhla zmenu rozsahu, ceny alebo termínu.",
    JOB_REQUIRED,
  ),
  "job.change_order.rejected": entry(
    "Zmena zákazky bola zamietnutá",
    "Navrhnutá zmena nebola schválená.",
    JOB_REQUIRED,
  ),
  "job.change_order.withdrawn": entry(
    "Návrh zmeny bol stiahnutý",
    "Protistrana stiahla predložený návrh zmeny zákazky.",
    JOB_REQUIRED,
  ),
  "job.completion.accepted": entry(
    "Dokončenie bolo potvrdené",
    "Dokončenie zákazky bolo potvrdené.",
    JOB_REQUIRED,
  ),
  "job.completion.admin_forced": entry(
    "Administratívne dokončenie zákazky",
    "Zákazka bola administratívne označená ako dokončená.",
    JOB_REQUIRED,
  ),
  "job.completion.proposal_agreed": entry(
    "Dohoda o dokončení",
    "Protistrana súhlasila s návrhom dokončenia zákazky.",
    JOB_REQUIRED,
  ),
  "job.completion.proposal_disagreed": entry(
    "Nesúhlas s návrhom dokončenia",
    "Protistrana nesúhlasila s návrhom dokončenia zákazky.",
    JOB_REQUIRED,
  ),
  "job.completion.proposed": entry(
    "Návrh dokončenia zákazky",
    "Protistrana navrhla spoločné potvrdenie dokončenia.",
    JOB_REQUIRED,
  ),
  "job.completion.rejected": entry(
    "Dokončenie nebolo potvrdené",
    "Žiadosť o potvrdenie dokončenia bola odmietnutá. Pozrite si kontext zákazky.",
    JOB_REQUIRED,
  ),
  "job.completion.requested": entry(
    "Potvrďte dokončenie",
    "Remeselník požiadal o potvrdenie dokončenia zákazky.",
    JOB_REQUIRED,
  ),
  "job.completion.withdrawn": entry(
    "Žiadosť o dokončenie bola stiahnutá",
    "Aktuálna žiadosť o potvrdenie dokončenia už neplatí.",
    JOB_OPTIONAL,
  ),
  "job.confirmed": entry(
    "Zákazka je potvrdená",
    "Ponuka bola prijatá a vznikla potvrdená zákazka. Kontakty a presná adresa zostávajú iba v zabezpečenom detaile.",
    MARKETPLACE_REQUIRED,
  ),
  "job.dispute.admin_action": entry(
    "Aktualizácia sporného prípadu",
    "V súkromnom prípade pribudla administratívna požiadavka alebo zmena stavu.",
    JOB_REQUIRED,
  ),
  "job.dispute.opened": entry(
    "Nový sporný prípad",
    "Protistrana otvorila súkromný prípad k zákazke.",
    JOB_REQUIRED,
  ),
  "job.dispute.party_action": entry(
    "Krok v spornom prípade",
    "Protistrana zaznamenala krok v súkromnom prípade.",
    JOB_OPTIONAL,
  ),
  "job.issue.created": entry(
    "Problém pri zákazke",
    "Pri zákazke bol zaznamenaný problém, meškanie alebo čakanie.",
    JOB_OPTIONAL,
  ),
  "job.progress.created": entry(
    "Novinka v priebehu zákazky",
    "Pri zákazke pribudla aktualizácia priebehu.",
    JOB_OPTIONAL,
  ),
  "job.review.main.invited": entry(
    "Ohodnoťte dokončenú zákazku",
    "Podeľte sa o skúsenosť. Hodnotenie je dobrovoľné a nežiada konkrétnu známku.",
    REVIEW_OPTIONAL,
  ),
  "job.review.main.unlocked": entry(
    "Hodnotenia sú sprístupnené",
    "Hodnotenia k dokončenej zákazke si teraz môžete pozrieť.",
    REVIEW_OPTIONAL,
  ),
  "job.review.response.created": entry(
    "Odpoveď na vaše hodnotenie",
    "Hodnotený remeselník zverejnil odpoveď na vaše hodnotenie.",
    REVIEW_OPTIONAL,
  ),
  "job.review.supervisor.visible": entry(
    "Nové technické hodnotenie",
    "Technické hodnotenie z dokončenej zákazky si môžete pozrieť v jej detaile.",
    REVIEW_OPTIONAL,
  ),
  "job.started": entry(
    "Práce sa začali",
    "Zákazka prešla do stavu realizácie.",
    JOB_REQUIRED,
  ),
  "job_invitation.expired": entry(
    "Pozvánka vypršala",
    "Na túto pozvánku už nie je možné reagovať.",
    MARKETPLACE_OPTIONAL,
  ),
  "job_invitation.expiry_reminder": entry(
    "Pozvánka čoskoro vyprší",
    "Ak máte záujem, odpovedzte na pozvánku pred jej vypršaním.",
    MARKETPLACE_REQUIRED,
  ),
  "job_invitation.not_selected": entry(
    "Ponuka nebola vybraná",
    "Zadávateľ vybral inú ponuku. Identita ani cena víťaza sa nezverejňuje.",
    MARKETPLACE_OPTIONAL,
  ),
  "job_invitation.provider_declined": entry(
    "Remeselník pozvánku odmietol",
    "Pozvaný remeselník sa do dopytu nezapojí.",
    MARKETPLACE_OPTIONAL,
  ),
  "job_invitation.provider_engaged": entry(
    "Remeselník sa zapojil",
    "Pozvaný remeselník prejavil záujem o váš dopyt.",
    MARKETPLACE_REQUIRED,
  ),
  "job_invitation.received": entry(
    "Nová pozvánka k dopytu",
    "Zadávateľ vás pozval reagovať na dopyt.",
    MARKETPLACE_REQUIRED,
  ),
  "job_invitation.request_closed": entry(
    "Dopyt bol uzavretý",
    "Pozvánka už nevyžaduje ďalšiu reakciu.",
    MARKETPLACE_OPTIONAL,
  ),
  "job_invitation.withdrawn_by_customer": entry(
    "Pozvánka bola stiahnutá",
    "Zadávateľ stiahol pozvánku k dopytu.",
    MARKETPLACE_OPTIONAL,
  ),
  "job_invitation.withdrawn_by_provider": entry(
    "Záujem bol stiahnutý",
    "Remeselník stiahol svoju účasť v dopyte.",
    MARKETPLACE_OPTIONAL,
  ),
  "job_participant.accepted": entry(
    "Účastník prijal pozvanie",
    "Pozvaný účastník prijal účasť na zákazke.",
    JOB_REQUIRED,
  ),
  "job_participant.declined": entry(
    "Účastník odmietol pozvanie",
    "Pozvaný účastník odmietol účasť na zákazke.",
    JOB_REQUIRED,
  ),
  "job_participant.departed": entry(
    "Účastník odišiel",
    "Účastník už na zákazke nepôsobí.",
    JOB_OPTIONAL,
  ),
  "job_participant.invited": entry(
    "Pozvanie k zákazke",
    "Boli ste pozvaný ako účastník zákazky.",
    JOB_REQUIRED,
  ),
  "job_participant.joined": entry(
    "Nový účastník zákazky",
    "Účastník sa pripojil k zákazke.",
    JOB_OPTIONAL,
  ),
  "job_participant.left": entry(
    "Účastník odišiel",
    "Účastník ukončil svoju účasť na zákazke.",
    JOB_OPTIONAL,
  ),
  "job_participant.removed": entry(
    "Účasť bola ukončená",
    "Vaša účasť na zákazke bola ukončená.",
    JOB_OPTIONAL,
  ),
  "job_request.materially_updated": entry(
    "Dopyt bol zmenený",
    "Zadávateľ zmenil podstatné údaje dopytu. Skontrolujte aktuálnu verziu.",
    MARKETPLACE_REQUIRED,
  ),
  "moderation.action.applied": entry(
    "Opatrenie k účtu alebo obsahu",
    "Bolo uplatnené opatrenie. Rozsah a bezpečný dôvod nájdete v detaile.",
    SECURITY_OPTIONAL,
    moderationBody,
  ),
  "moderation.appeal.decided": entry(
    "Rozhodnutie o odvolaní",
    "Vaše odvolanie bolo posúdené. Výsledok nájdete v detaile opatrenia.",
    SECURITY_OPTIONAL,
  ),
  "profile.approved": entry(
    "Profil bol schválený",
    "Váš remeselnícky profil prešiel kontrolou publikovania.",
    SECURITY_OPTIONAL,
  ),
  "profile.rejected": entry(
    "Profil nebol schválený",
    "Kontrola profilu skončila zamietnutím. Bezpečný dôvod nájdete v detaile profilu.",
    SECURITY_OPTIONAL,
  ),
  "quote.expired": entry(
    "Ponuka vypršala",
    "Platnosť ponuky sa skončila.",
    MARKETPLACE_OPTIONAL,
  ),
  "quote.rejected": entry(
    "Ponuka bola zamietnutá",
    "Zadávateľ vašu ponuku neprijal.",
    MARKETPLACE_OPTIONAL,
  ),
  "quote.revised": entry(
    "Ponuka bola zmenená",
    "Remeselník odoslal novú revíziu ceny alebo podmienok.",
    MARKETPLACE_REQUIRED,
  ),
  "quote.submitted": entry(
    "Nová ponuka",
    "K dopytu bola odoslaná ponuka na posúdenie.",
    MARKETPLACE_REQUIRED,
  ),
  "quote.withdrawn": entry(
    "Ponuka bola stiahnutá",
    "Remeselník stiahol svoju ponuku.",
    MARKETPLACE_OPTIONAL,
  ),
});

export const ALPHA_NOTIFICATION_TYPES = Object.freeze(Object.keys(CATALOG));

export function getNotificationPolicy(type: string): NotificationPolicy {
  const found = CATALOG[type];
  if (found === undefined)
    throw new TypeError(`Unknown notification type: ${type}`);
  return Object.freeze({
    category: found.category,
    emailRequired: found.emailRequired,
  });
}

export function getNotificationPresentation(
  type: string,
  payload: EventPayload,
): NotificationPresentation {
  const found = CATALOG[type];
  if (found === undefined)
    throw new TypeError(`Unknown notification type: ${type}`);
  return Object.freeze({
    body: found.bodyForPayload?.(payload) ?? found.body,
    category: found.category,
    emailRequired: found.emailRequired,
    title: found.title,
  });
}

function policy(
  category: NotificationCategory,
  emailRequired: boolean,
): NotificationPolicy {
  return Object.freeze({ category, emailRequired });
}

function entry(
  title: string,
  body: string,
  value: NotificationPolicy,
  bodyForPayload?: (payload: EventPayload) => string,
): CatalogEntry {
  return Object.freeze({
    ...value,
    title,
    body,
    ...(bodyForPayload === undefined ? {} : { bodyForPayload }),
  });
}

function moderationBody(payload: EventPayload): string {
  const action = payload["action"];
  if (
    action === "APPLY_TEMPORARY_SUSPENSION" ||
    action === "APPLY_INDEFINITE_SUSPENSION"
  ) {
    return "Prístup k účtu bol pozastavený. Rozsah, bezpečný dôvod a možnosť odvolania nájdete v detaile.";
  }
  if (action === "APPLY_FEATURE_RESTRICTION") {
    return "Jedna z funkcií účtu bola obmedzená. Rozsah, bezpečný dôvod a možnosť odvolania nájdete v detaile.";
  }
  if (action === "HIDE_CONTENT" || action === "EXCLUDE_REVIEW_EVIDENCE") {
    return "Obsah bol skrytý alebo vylúčený z hodnotenia. Bezpečný dôvod a možnosť odvolania nájdete v detaile.";
  }
  return "K účtu alebo obsahu bolo pridané upozornenie. Bezpečný dôvod nájdete v detaile.";
}
