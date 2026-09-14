import type {
  AppendConsentEventResult,
  AppendPrivacyRequestEventResult,
  ConsentEventDraft,
  CreatePrivacyRequestCaseResult,
  PrivacyAuditIntegrationPort,
  PrivacyAuditProjectionEvent,
  PrivacyRepository,
  PrivacyRequestCaseDraft,
  PrivacyRequestEventDraft,
} from "./model.js";

export function createPrivacyService(input: {
  readonly audit: PrivacyAuditIntegrationPort;
  readonly repository: PrivacyRepository;
}) {
  return Object.freeze({
    async recordConsent(
      event: ConsentEventDraft,
    ): Promise<AppendConsentEventResult> {
      const result = await input.repository.appendConsentEvent(event);
      if (result.status === "APPENDED" || result.status === "DEDUPLICATED") {
        await input.audit.project(
          consentAuditProjection(result.event, event.subjectUserId),
        );
      }
      return result;
    },

    async openPrivacyRequest(
      request: PrivacyRequestCaseDraft,
    ): Promise<CreatePrivacyRequestCaseResult> {
      const result = await input.repository.createPrivacyRequestCase(request);
      await input.audit.project({
        action: "privacy.request.opened",
        actorUserId: request.subjectUserId,
        correlationId: result.event.correlationId,
        eventId: result.event.eventId,
        outcome: result.requestType,
        subjectUserId: result.subjectUserId,
        targetId: result.caseId,
        targetType: "PRIVACY_REQUEST",
      });
      return result;
    },

    async transitionPrivacyRequest(
      event: PrivacyRequestEventDraft,
    ): Promise<AppendPrivacyRequestEventResult> {
      const result = await input.repository.appendPrivacyRequestEvent(event);
      if (result.status === "APPENDED" || result.status === "DEDUPLICATED") {
        await input.audit.project({
          action: "privacy.request.transitioned",
          actorUserId: result.event.actorUserId,
          correlationId: result.event.correlationId,
          eventId: result.event.eventId,
          outcome: result.event.state,
          subjectUserId: result.event.subjectUserId,
          targetId: result.event.caseId,
          targetType: "PRIVACY_REQUEST",
        });
      }
      return result;
    },
  });
}

function consentAuditProjection(
  event: Extract<
    AppendConsentEventResult,
    { readonly status: "APPENDED" | "DEDUPLICATED" }
  >["event"],
  subjectUserId: PrivacyAuditProjectionEvent["subjectUserId"],
): PrivacyAuditProjectionEvent {
  return Object.freeze({
    action:
      event.action === "GRANTED"
        ? "privacy.consent.granted"
        : "privacy.consent.withdrawn",
    actorUserId: subjectUserId,
    correlationId: event.correlationId,
    eventId: event.eventId,
    outcome: event.purpose,
    subjectUserId,
    targetId: event.eventId,
    targetType: "CONSENT",
  });
}
