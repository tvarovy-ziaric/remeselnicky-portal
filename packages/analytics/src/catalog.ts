export const analyticsEventNames = [
  "public_profile_viewed",
  "search_started",
  "search_executed",
  "search_results_viewed",
  "craftsman_profile_opened_from_search",
  "craftsman_request_cta_clicked",
  "shortlist_added",
  "shortlist_removed",
  "registration_completed",
  "email_verification_completed",
  "phone_verification_completed",
  "job_request_started",
  "job_request_submitted",
  "job_request_cancelled",
  "job_request_expired",
  "job_request_reactivated",
  "job_request_materially_revised",
  "invitation_sent",
  "invitation_received",
  "invitation_viewed",
  "invitation_engaged",
  "invitation_declined",
  "invitation_expired",
  "invitation_withdrawn",
  "invitation_not_selected",
  "conversation_first_message_sent",
  "conversation_bilateral_participation_reached",
  "conversation_attachment_ready",
  "quote_draft_created",
  "quote_submitted",
  "quote_revision_submitted",
  "quote_rejected",
  "quote_withdrawn",
  "quote_expired",
  "quote_viewed",
  "quote_comparison_opened",
  "quote_comparison_pdf_opened",
  "quote_accepted",
  "job_confirmed",
  "job_started",
  "job_participant_invited",
  "job_participant_joined",
  "job_participant_left",
  "job_progress_update_created",
  "job_issue_created",
  "job_milestone_created",
  "job_milestone_state_changed",
  "change_order_proposed",
  "change_order_revised",
  "change_order_approved",
  "change_order_rejected",
  "change_order_withdrawn",
  "job_completion_requested",
  "job_completion_request_viewed",
  "job_completion_accepted",
  "job_completion_rejected",
  "job_completed",
  "review_opportunity_opened",
  "review_submitted",
  "review_opportunity_expired",
  "review_pair_completed",
  "participant_review_submitted",
  "workgroup_review_submitted",
  "supervisor_evaluation_submitted",
  "review_response_created",
  "review_report_created",
  "dispute_opened",
  "dispute_closed",
  "report_created",
  "moderation_action_applied",
  "notification_created",
  "notification_delivery_succeeded",
  "notification_delivery_failed",
  "notification_in_app_read",
  "notification_deep_link_opened",
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];

export const SEARCH_ANALYTICS_VERSION = "R2_SEARCH_V1" as const;

export type AnalyticsPropertyKind =
  | "AUTHORING_MODE"
  | "ATTACHMENT_COUNT_BUCKET"
  | "ATTACHMENT_TYPE_BUCKET"
  | "BOOLEAN"
  | "BOUNDED_QUOTE_COUNT"
  | "CANCELLATION_REASON"
  | "CTA_ORIGIN"
  | "DECLINE_REASON"
  | "DRAFT_ORIGIN"
  | "EFFECT_INITIATOR"
  | "GOVERNED_LOCATION_AREA_CODE"
  | "INVITATION_WITHDRAWAL_SOURCE"
  | "LOCATION_AREA_GRANULARITY"
  | "LOCATION_SCOPE"
  | "MACHINE_CODE"
  | "MESSAGE_COUNT_BUCKET"
  | "MATERIAL_REVISION_COUNT_BUCKET"
  | "PHOTO_COUNT_BUCKET"
  | "POSITIVE_INTEGER"
  | "PRICE_MODE"
  | "PROFESSION_CODE"
  | "PROFILE_CONTEXT"
  | "RESULT_COUNT_BUCKET"
  | "RESULT_POSITION"
  | "SEARCH_AVAILABILITY_COUNT_BUCKET"
  | "SEARCH_SORT_MODE"
  | "SEARCH_VERSION"
  | "SHORTLIST_SIZE_BUCKET"
  | "SPECIALIZATION_CODE"
  | "TIMING_OPTION"
  | "UUID";

export type AnalyticsPropertyRule =
  | AnalyticsPropertyKind
  | Readonly<{
      kind: AnalyticsPropertyKind;
      optional: true;
    }>;

export interface AnalyticsEventDefinition {
  readonly description: string;
  readonly properties: Readonly<Record<string, AnalyticsPropertyRule>>;
  readonly schema_version: number;
  readonly source: "CLIENT_UX" | "SERVER_DOMAIN" | "SERVER_QUERY";
  readonly trigger: string;
}

/**
 * The deliberately small, feature-owned catalog rejects ad-hoc names and
 * properties. R4-027 may compose dashboards from these stable observations;
 * it must not reinterpret their documented triggers or denominators.
 */
export const analyticsEventCatalog = Object.freeze({
  public_profile_viewed: definition(
    "A public CraftsmanProfile was viewed.",
    "When an actually visible public profile view is accepted for UX analytics.",
    { craftsman_profile_id: "UUID" },
    "CLIENT_UX",
  ),
  search_started: definition(
    "A visitor explicitly started a new public craftsman search.",
    "When an explicit submit or normalized filter/sort change starts a new first-page search; never on typing or autocomplete.",
    { search_id: "UUID" },
    "CLIENT_UX",
  ),
  search_executed: definition(
    "A public craftsman search completed after all authoritative eligibility gates.",
    "On the server after the first-page search snapshot completes successfully; invalid and failed searches do not emit it.",
    {
      eligible_result_count_bucket: "RESULT_COUNT_BUCKET",
      include_outside_declared_area: "BOOLEAN",
      indicative_availability_filter: "BOOLEAN",
      indicatively_available_count_bucket: "SEARCH_AVAILABILITY_COUNT_BUCKET",
      location_area_code: optional("GOVERNED_LOCATION_AREA_CODE"),
      location_area_granularity: optional("LOCATION_AREA_GRANULARITY"),
      location_scope: "LOCATION_SCOPE",
      profession_code: "PROFESSION_CODE",
      search_id: "UUID",
      search_version: "SEARCH_VERSION",
      skill_filter_used: "BOOLEAN",
      sort_mode: "SEARCH_SORT_MODE",
      specialization_code: optional("SPECIALIZATION_CODE"),
      timing_supplied: "BOOLEAN",
    },
    "SERVER_QUERY",
  ),
  search_results_viewed: definition(
    "A public search result list or zero-result state became visible.",
    "When the first-page result state is actually visible; never on server render alone or link prefetch.",
    {
      rendered_result_count_bucket: "RESULT_COUNT_BUCKET",
      search_id: "UUID",
      search_version: "SEARCH_VERSION",
      sort_mode: "SEARCH_SORT_MODE",
    },
    "CLIENT_UX",
  ),
  craftsman_profile_opened_from_search: definition(
    "A visitor opened one craftsman profile from a visible search result.",
    "On an actual user navigation from a result card, not hover, impression or prefetch.",
    {
      craftsman_profile_id: "UUID",
      result_position: "RESULT_POSITION",
      search_id: "UUID",
      search_version: "SEARCH_VERSION",
      sort_mode: "SEARCH_SORT_MODE",
    },
    "CLIENT_UX",
  ),
  craftsman_request_cta_clicked: definition(
    "A visitor clicked the request/contact CTA for a public craftsman.",
    "On the explicit CTA interaction; this is not a submitted request or completed business conversion.",
    {
      craftsman_profile_id: "UUID",
      origin: "CTA_ORIGIN",
      search_id: optional("UUID"),
    },
    "CLIENT_UX",
  ),
  shortlist_added: definition(
    "A craftsman was added to a customer's private shortlist.",
    "After an R2-012 ADD command commits with APPLIED; never for retry, DEDUPLICATED or UNCHANGED.",
    {
      shortlist_size_bucket: "SHORTLIST_SIZE_BUCKET",
    },
  ),
  shortlist_removed: definition(
    "A craftsman was removed from a customer's private shortlist.",
    "After an R2-012 REMOVE command commits with APPLIED; never for retry, DEDUPLICATED or UNCHANGED.",
    {
      shortlist_size_bucket: "SHORTLIST_SIZE_BUCKET",
    },
  ),
  registration_completed: definition(
    "A new eligible user account was committed successfully.",
    "After the registration transaction commits.",
    {},
  ),
  email_verification_completed: definition(
    "An account email became verified.",
    "After the email-verification transaction commits.",
    {},
  ),
  phone_verification_completed: definition(
    "An account phone number became verified.",
    "After the phone-verification transaction commits.",
    {},
  ),
  job_request_started: definition(
    "An authenticated customer created a new JobRequest draft.",
    "After the first committed CREATE_DRAFT effect; retries and later autosaves do not emit it.",
    { job_request_id: "UUID" },
  ),
  job_request_submitted: definition(
    "A JobRequest entered its submitted state.",
    "After the JobRequest submission transaction commits.",
    {
      budget_provided: "BOOLEAN",
      job_request_id: "UUID",
      photo_count_bucket: "PHOTO_COUNT_BUCKET",
      profession_code: "PROFESSION_CODE",
      timing_option: "TIMING_OPTION",
    },
    "SERVER_DOMAIN",
    2,
  ),
  job_request_cancelled: definition(
    "An active JobRequest was cancelled by its customer.",
    "After the cancellation revision commits.",
    {
      cancellation_reason_category: "CANCELLATION_REASON",
      job_request_id: "UUID",
    },
  ),
  job_request_expired: definition(
    "An active JobRequest expired by the server clock.",
    "After the system expiry revision commits.",
    { effect_initiator: "EFFECT_INITIATOR", job_request_id: "UUID" },
  ),
  job_request_reactivated: definition(
    "An expired JobRequest was reactivated.",
    "After the customer reactivation revision commits.",
    { job_request_id: "UUID" },
  ),
  job_request_materially_revised: definition(
    "An active JobRequest received a material visible revision.",
    "After one request-level material revision commits; notification fanout does not multiply it.",
    {
      job_request_id: "UUID",
      material_revision_count_bucket: "MATERIAL_REVISION_COUNT_BUCKET",
      visible_version: "POSITIVE_INTEGER",
    },
  ),
  invitation_sent: definition(
    "A customer sent a JobInvitation.",
    "After the initial PENDING invitation revision commits.",
    { invitation_id: "UUID", job_request_id: "UUID" },
  ),
  invitation_received: definition(
    "A craftsman received a JobInvitation.",
    "Derived once from the same committed SEND effect as invitation_sent, with a distinct event ID.",
    { invitation_id: "UUID", job_request_id: "UUID" },
  ),
  invitation_viewed: definition(
    "A provider actually viewed an invitation detail.",
    "After a consented viewport observation is reauthorized once per invitation.",
    { invitation_id: "UUID", job_request_id: "UUID" },
    "CLIENT_UX",
  ),
  invitation_engaged: definition(
    "An invitation entered ENGAGED.",
    "After the invitation engagement transaction commits.",
    { invitation_id: "UUID", job_request_id: "UUID" },
  ),
  invitation_declined: definition(
    "A craftsman explicitly declined an invitation.",
    "After the DECLINED revision commits; optional reason is a governed category only.",
    {
      decline_reason_category: optional("DECLINE_REASON"),
      invitation_id: "UUID",
      job_request_id: "UUID",
    },
  ),
  invitation_expired: definition(
    "A pending invitation expired without response.",
    "After the system EXPIRED revision commits.",
    {
      effect_initiator: "EFFECT_INITIATOR",
      invitation_id: "UUID",
      job_request_id: "UUID",
    },
  ),
  invitation_withdrawn: definition(
    "An invitation candidacy was withdrawn or closed.",
    "After the corresponding WITHDRAWN revision commits.",
    {
      invitation_id: "UUID",
      job_request_id: "UUID",
      withdrawal_source: "INVITATION_WITHDRAWAL_SOURCE",
    },
  ),
  invitation_not_selected: definition(
    "An invitation entered neutral NOT_SELECTED.",
    "After CUSTOMER_STOP or system NOT_SELECT commits.",
    {
      effect_initiator: "EFFECT_INITIATOR",
      invitation_id: "UUID",
      job_request_id: "UUID",
    },
  ),
  conversation_first_message_sent: definition(
    "The first human message in an engaged conversation was committed.",
    "At the first HUMAN_MESSAGE effect, independently of notification mute state.",
    {
      conversation_id: "UUID",
      initiator_profile_context: "PROFILE_CONTEXT",
      invitation_id: "UUID",
    },
  ),
  conversation_bilateral_participation_reached: definition(
    "Both exact conversation parties have authored at least one human message.",
    "At the first HUMAN_MESSAGE effect that makes participation bilateral.",
    {
      conversation_id: "UUID",
      invitation_id: "UUID",
      message_count_bucket: "MESSAGE_COUNT_BUCKET",
    },
  ),
  conversation_attachment_ready: definition(
    "A safe chat attachment became READY.",
    "After canonical processing, with only bounded count/type buckets.",
    {
      attachment_count_bucket: "ATTACHMENT_COUNT_BUCKET",
      attachment_type_bucket: "ATTACHMENT_TYPE_BUCKET",
      conversation_id: "UUID",
    },
  ),
  quote_draft_created: definition(
    "A new immutable Quote draft revision was created.",
    "After CREATE_DRAFT or CREATE_REVISION commits.",
    {
      authoring_mode: "AUTHORING_MODE",
      draft_origin: "DRAFT_ORIGIN",
      job_request_id: "UUID",
      quote_id: "UUID",
      quote_revision: "POSITIVE_INTEGER",
    },
  ),
  quote_submitted: definition(
    "The first Quote revision was submitted.",
    "After revision 1 enters SUBMITTED; later revisions use quote_revision_submitted.",
    {
      authoring_mode: "AUTHORING_MODE",
      job_request_id: "UUID",
      price_mode: optional("PRICE_MODE"),
      quote_id: "UUID",
      quote_revision: "POSITIVE_INTEGER",
    },
    "SERVER_DOMAIN",
    2,
  ),
  quote_revision_submitted: definition(
    "A later Quote revision was submitted.",
    "After a Quote revision greater than one enters SUBMITTED.",
    {
      authoring_mode: "AUTHORING_MODE",
      job_request_id: "UUID",
      price_mode: optional("PRICE_MODE"),
      quote_id: "UUID",
      quote_revision: "POSITIVE_INTEGER",
    },
  ),
  quote_rejected: quoteTerminalDefinition(
    "rejected by its customer",
    "REJECTED",
  ),
  quote_withdrawn: quoteTerminalDefinition(
    "withdrawn by its provider",
    "WITHDRAWN",
  ),
  quote_expired: quoteTerminalDefinition(
    "expired by the server clock",
    "EXPIRED",
    { effect_initiator: "EFFECT_INITIATOR" },
  ),
  quote_viewed: definition(
    "A customer actually viewed a submitted Quote revision.",
    "After a consented visible-client observation is reauthorized and committed once per revision.",
    quoteIdentityProperties(),
    "CLIENT_UX",
  ),
  quote_comparison_opened: definition(
    "A customer actually opened an authorized Quote comparison.",
    "After a consented visible-client observation is reauthorized and committed once per request.",
    { available_quote_count: "BOUNDED_QUOTE_COUNT", job_request_id: "UUID" },
    "CLIENT_UX",
  ),
  quote_comparison_pdf_opened: definition(
    "A customer opened an authorized canonical external Quote PDF.",
    "After private delivery authorization succeeds and the consented observation commits.",
    quoteIdentityProperties(),
    "CLIENT_UX",
  ),
  quote_accepted: definition(
    "A Quote was accepted through the successful acceptance command.",
    "After the atomic Quote acceptance and Job creation transaction commits.",
    { job_id: "UUID", job_request_id: "UUID", quote_id: "UUID" },
  ),
  job_confirmed: definition(
    "A confirmed Job was created from an accepted Quote.",
    "After the atomic Quote acceptance and Job creation transaction commits.",
    { job_id: "UUID", job_request_id: "UUID", quote_id: "UUID" },
  ),
  job_started: definition(
    "A confirmed Job entered actual execution.",
    "After the authoritative Job start transition commits.",
    { job_id: "UUID" },
  ),
  job_participant_invited: definition(
    "A verified Job participant invitation was created.",
    "After the participant invitation transaction commits.",
    { job_id: "UUID", participant_id: "UUID", role_code: "MACHINE_CODE" },
  ),
  job_participant_joined: definition(
    "An invited participant joined the Job.",
    "After the participant join transition commits.",
    { job_id: "UUID", participant_id: "UUID", role_code: "MACHINE_CODE" },
  ),
  job_participant_left: definition(
    "A participant left or was removed from the Job.",
    "After the history-preserving leave transition commits.",
    { job_id: "UUID", participant_id: "UUID", role_code: "MACHINE_CODE" },
  ),
  job_progress_update_created: definition(
    "A bounded Job progress update was created.",
    "After the progress update commits; message text and media metadata are excluded.",
    { job_id: "UUID", progress_state: "MACHINE_CODE" },
  ),
  job_issue_created: definition(
    "A Job issue marker was created.",
    "After the issue commits; explanatory text is excluded.",
    { issue_category: "MACHINE_CODE", job_id: "UUID" },
  ),
  job_milestone_created: definition(
    "A Job milestone was created.",
    "After milestone creation commits; title and notes are excluded.",
    { job_id: "UUID", milestone_id: "UUID" },
  ),
  job_milestone_state_changed: definition(
    "A Job milestone entered a new governed state.",
    "After the authoritative milestone transition commits.",
    { job_id: "UUID", milestone_id: "UUID", milestone_state: "MACHINE_CODE" },
  ),
  change_order_proposed: changeOrderDefinition("was proposed", "PROPOSED"),
  change_order_revised: changeOrderDefinition(
    "received a revised proposal",
    "REVISED",
  ),
  change_order_approved: changeOrderDefinition("was approved", "APPROVED"),
  change_order_rejected: changeOrderDefinition("was rejected", "REJECTED"),
  change_order_withdrawn: changeOrderDefinition("was withdrawn", "WITHDRAWN"),
  job_completion_requested: definition(
    "Completion was requested for a Job.",
    "After a completion-attempt request commits.",
    { completion_attempt_id: "UUID", job_id: "UUID" },
  ),
  job_completion_request_viewed: definition(
    "A customer actually viewed a completion request.",
    "After an authorized visible-client observation is committed.",
    { completion_attempt_id: "UUID", job_id: "UUID" },
    "CLIENT_UX",
  ),
  job_completion_accepted: definition(
    "A completion request was accepted.",
    "After the authoritative customer/admin acceptance commits.",
    {
      completion_attempt_id: "UUID",
      decision_source: "MACHINE_CODE",
      job_id: "UUID",
    },
  ),
  job_completion_rejected: definition(
    "A completion request was rejected with a governed category.",
    "After rejection commits; objection text is excluded.",
    {
      completion_attempt_id: "UUID",
      job_id: "UUID",
      rejection_category: "MACHINE_CODE",
    },
  ),
  job_completed: definition(
    "A Job reached its final COMPLETED state.",
    "After the completion transaction commits.",
    { job_id: "UUID" },
  ),
  review_opportunity_opened: definition(
    "A verified completed-Job review opportunity opened.",
    "After the authoritative opportunity is created or unlocked.",
    { job_id: "UUID", review_source: "MACHINE_CODE" },
  ),
  review_submitted: definition(
    "An eligible verified-Job review was submitted.",
    "After the review submission transaction commits.",
    { job_id: "UUID", review_id: "UUID" },
  ),
  review_opportunity_expired: definition(
    "A review opportunity expired without submission.",
    "After the server closes the review window.",
    { job_id: "UUID", review_source: "MACHINE_CODE" },
  ),
  review_pair_completed: definition(
    "Both bilateral main-review sides submitted for a completed Job.",
    "After the second authoritative main review commits.",
    { job_id: "UUID" },
  ),
  participant_review_submitted: definition(
    "An optional verified participant review was submitted.",
    "After the Job-context participant review transaction commits.",
    { job_id: "UUID", participant_id: "UUID", review_id: "UUID" },
  ),
  workgroup_review_submitted: definition(
    "An optional historical workgroup review was submitted.",
    "After the Job-context workgroup review transaction commits.",
    { job_id: "UUID", review_id: "UUID", workgroup_id: "UUID" },
  ),
  supervisor_evaluation_submitted: definition(
    "A verified supervisor evaluation was submitted.",
    "After the non-bilateral evaluation transaction commits.",
    { evaluation_id: "UUID", job_id: "UUID", participant_id: "UUID" },
  ),
  review_response_created: definition(
    "A rated profile owner created a public review response.",
    "After the response transaction commits; response text is excluded.",
    { job_id: "UUID", review_id: "UUID" },
  ),
  review_report_created: definition(
    "A review-context moderation report was created.",
    "After the independent report transaction commits; report text is excluded.",
    {
      job_id: "UUID",
      reason_code: "MACHINE_CODE",
      target_type: "MACHINE_CODE",
    },
  ),
  dispute_opened: definition(
    "A private Job dispute case was opened.",
    "After the dispute transaction commits; statements and evidence are excluded.",
    { dispute_id: "UUID", job_id: "UUID", reason_code: "MACHINE_CODE" },
  ),
  dispute_closed: definition(
    "A private Job dispute case reached a terminal outcome.",
    "After the authoritative terminal transition commits.",
    { dispute_id: "UUID", job_id: "UUID", outcome_code: "MACHINE_CODE" },
  ),
  report_created: definition(
    "A governed moderation report was created.",
    "After report creation commits; narrative and evidence are excluded.",
    {
      reason_code: "MACHINE_CODE",
      report_id: "UUID",
      target_type: "MACHINE_CODE",
    },
  ),
  moderation_action_applied: definition(
    "A history-preserving moderation action was applied.",
    "After the privileged action transaction commits.",
    {
      action_code: "MACHINE_CODE",
      reason_code: "MACHINE_CODE",
      target_type: "MACHINE_CODE",
    },
  ),
  notification_created: notificationDefinition(
    "A canonical notification was created.",
    "After canonical notification fanout commits.",
  ),
  notification_delivery_succeeded: notificationDefinition(
    "A notification delivery succeeded.",
    "After the provider delivery receipt is committed.",
  ),
  notification_delivery_failed: notificationDefinition(
    "A notification delivery failed terminally.",
    "After the terminal delivery failure receipt is committed.",
  ),
  notification_in_app_read: notificationDefinition(
    "A user marked an in-app notification as read.",
    "After the authenticated read command commits; this is not business acceptance.",
  ),
  notification_deep_link_opened: notificationDefinition(
    "A user opened a notification deep link.",
    "After an authorized explicit navigation observation; this is not business acceptance.",
    "CLIENT_UX",
  ),
} satisfies Readonly<Record<AnalyticsEventName, AnalyticsEventDefinition>>);

const historicalAnalyticsEventDefinitions = Object.freeze({
  job_request_submitted: Object.freeze({
    1: definition(
      "A JobRequest entered its submitted state (legacy R0 schema).",
      "Historical replay of the committed JobRequest submission effect.",
      { job_request_id: "UUID" },
    ),
  }),
  quote_submitted: Object.freeze({
    1: definition(
      "A Quote revision was submitted (legacy R0 schema).",
      "Historical replay of any committed Quote revision submission.",
      { job_request_id: "UUID", quote_id: "UUID" },
    ),
  }),
});

/** Exact version lookup; incompatible KPI definitions are never guessed. */
export function analyticsEventDefinition(
  eventName: AnalyticsEventName,
  schemaVersion: number,
): AnalyticsEventDefinition | undefined {
  const current = analyticsEventCatalog[eventName];
  if (current.schema_version === schemaVersion) return current;
  if (eventName === "job_request_submitted" && schemaVersion === 1) {
    return historicalAnalyticsEventDefinitions.job_request_submitted[1];
  }
  if (eventName === "quote_submitted" && schemaVersion === 1) {
    return historicalAnalyticsEventDefinitions.quote_submitted[1];
  }
  return undefined;
}

export type AnalyticsPropertiesByName = {
  readonly public_profile_viewed: Readonly<{
    craftsman_profile_id: string;
  }>;
  readonly search_started: Readonly<{ search_id: string }>;
  readonly search_executed: Readonly<{
    eligible_result_count_bucket: AnalyticsResultCountBucket;
    include_outside_declared_area: boolean;
    indicative_availability_filter: boolean;
    indicatively_available_count_bucket: AnalyticsAvailabilityCountBucket;
    location_area_code?: string;
    location_area_granularity?: AnalyticsLocationAreaGranularity;
    location_scope: AnalyticsLocationScope;
    profession_code: string;
    search_id: string;
    search_version: typeof SEARCH_ANALYTICS_VERSION;
    skill_filter_used: boolean;
    sort_mode: AnalyticsSearchSortMode;
    specialization_code?: string;
    timing_supplied: boolean;
  }>;
  readonly search_results_viewed: Readonly<{
    rendered_result_count_bucket: AnalyticsResultCountBucket;
    search_id: string;
    search_version: typeof SEARCH_ANALYTICS_VERSION;
    sort_mode: AnalyticsSearchSortMode;
  }>;
  readonly craftsman_profile_opened_from_search: Readonly<{
    craftsman_profile_id: string;
    result_position: number;
    search_id: string;
    search_version: typeof SEARCH_ANALYTICS_VERSION;
    sort_mode: AnalyticsSearchSortMode;
  }>;
  readonly craftsman_request_cta_clicked: Readonly<{
    craftsman_profile_id: string;
    origin: AnalyticsCtaOrigin;
    search_id?: string;
  }>;
  readonly shortlist_added: Readonly<{
    shortlist_size_bucket: AnalyticsShortlistSizeBucket;
  }>;
  readonly shortlist_removed: Readonly<{
    shortlist_size_bucket: AnalyticsShortlistSizeBucket;
  }>;
  readonly registration_completed: Readonly<Record<string, never>>;
  readonly email_verification_completed: Readonly<Record<string, never>>;
  readonly phone_verification_completed: Readonly<Record<string, never>>;
  readonly job_request_started: Readonly<{ job_request_id: string }>;
  readonly job_request_submitted: Readonly<{
    budget_provided: boolean;
    job_request_id: string;
    photo_count_bucket: AnalyticsPhotoCountBucket;
    profession_code: string;
    timing_option: AnalyticsTimingOption;
  }>;
  readonly job_request_cancelled: Readonly<{
    cancellation_reason_category: AnalyticsCancellationReason;
    job_request_id: string;
  }>;
  readonly job_request_expired: Readonly<{
    effect_initiator: AnalyticsEffectInitiator;
    job_request_id: string;
  }>;
  readonly job_request_reactivated: Readonly<{ job_request_id: string }>;
  readonly job_request_materially_revised: Readonly<{
    job_request_id: string;
    material_revision_count_bucket: AnalyticsMaterialRevisionCountBucket;
    visible_version: number;
  }>;
  readonly invitation_sent: AnalyticsInvitationIdentity;
  readonly invitation_received: AnalyticsInvitationIdentity;
  readonly invitation_viewed: AnalyticsInvitationIdentity;
  readonly invitation_engaged: Readonly<{
    invitation_id: string;
    job_request_id: string;
  }>;
  readonly invitation_declined: Readonly<
    AnalyticsInvitationIdentity & {
      decline_reason_category?: AnalyticsDeclineReason;
    }
  >;
  readonly invitation_expired: Readonly<
    AnalyticsInvitationIdentity & { effect_initiator: AnalyticsEffectInitiator }
  >;
  readonly invitation_withdrawn: Readonly<
    AnalyticsInvitationIdentity & {
      withdrawal_source: AnalyticsInvitationWithdrawalSource;
    }
  >;
  readonly invitation_not_selected: Readonly<
    AnalyticsInvitationIdentity & { effect_initiator: AnalyticsEffectInitiator }
  >;
  readonly conversation_first_message_sent: Readonly<{
    conversation_id: string;
    initiator_profile_context: AnalyticsProfileContextValue;
    invitation_id: string;
  }>;
  readonly conversation_bilateral_participation_reached: Readonly<{
    conversation_id: string;
    invitation_id: string;
    message_count_bucket: AnalyticsMessageCountBucket;
  }>;
  readonly conversation_attachment_ready: Readonly<{
    attachment_count_bucket: AnalyticsAttachmentCountBucket;
    attachment_type_bucket: AnalyticsAttachmentTypeBucket;
    conversation_id: string;
  }>;
  readonly quote_draft_created: Readonly<
    AnalyticsQuoteIdentity & { draft_origin: AnalyticsQuoteDraftOrigin }
  >;
  readonly quote_submitted: Readonly<{
    authoring_mode: AnalyticsQuoteAuthoringMode;
    job_request_id: string;
    price_mode?: AnalyticsQuotePriceMode;
    quote_id: string;
    quote_revision: number;
  }>;
  readonly quote_revision_submitted: AnalyticsQuoteIdentity;
  readonly quote_rejected: AnalyticsQuoteIdentity;
  readonly quote_withdrawn: AnalyticsQuoteIdentity;
  readonly quote_expired: Readonly<
    AnalyticsQuoteIdentity & { effect_initiator: AnalyticsEffectInitiator }
  >;
  readonly quote_viewed: AnalyticsQuoteIdentity;
  readonly quote_comparison_opened: Readonly<{
    available_quote_count: number;
    job_request_id: string;
  }>;
  readonly quote_comparison_pdf_opened: AnalyticsQuoteIdentity;
  readonly quote_accepted: Readonly<{
    job_id: string;
    job_request_id: string;
    quote_id: string;
  }>;
  readonly job_confirmed: Readonly<{
    job_id: string;
    job_request_id: string;
    quote_id: string;
  }>;
  readonly job_started: AnalyticsJobIdentity;
  readonly job_participant_invited: AnalyticsParticipantIdentity;
  readonly job_participant_joined: AnalyticsParticipantIdentity;
  readonly job_participant_left: AnalyticsParticipantIdentity;
  readonly job_progress_update_created: Readonly<
    AnalyticsJobIdentity & { progress_state: string }
  >;
  readonly job_issue_created: Readonly<
    AnalyticsJobIdentity & { issue_category: string }
  >;
  readonly job_milestone_created: AnalyticsMilestoneIdentity;
  readonly job_milestone_state_changed: Readonly<
    AnalyticsMilestoneIdentity & { milestone_state: string }
  >;
  readonly change_order_proposed: AnalyticsChangeOrderIdentity;
  readonly change_order_revised: AnalyticsChangeOrderIdentity;
  readonly change_order_approved: AnalyticsChangeOrderIdentity;
  readonly change_order_rejected: AnalyticsChangeOrderIdentity;
  readonly change_order_withdrawn: AnalyticsChangeOrderIdentity;
  readonly job_completion_requested: AnalyticsCompletionIdentity;
  readonly job_completion_request_viewed: AnalyticsCompletionIdentity;
  readonly job_completion_accepted: Readonly<
    AnalyticsCompletionIdentity & { decision_source: string }
  >;
  readonly job_completion_rejected: Readonly<
    AnalyticsCompletionIdentity & { rejection_category: string }
  >;
  readonly job_completed: Readonly<{ job_id: string }>;
  readonly review_opportunity_opened: Readonly<
    AnalyticsJobIdentity & { review_source: string }
  >;
  readonly review_submitted: Readonly<{
    job_id: string;
    review_id: string;
  }>;
  readonly review_opportunity_expired: Readonly<
    AnalyticsJobIdentity & { review_source: string }
  >;
  readonly review_pair_completed: AnalyticsJobIdentity;
  readonly participant_review_submitted: Readonly<{
    job_id: string;
    participant_id: string;
    review_id: string;
  }>;
  readonly workgroup_review_submitted: Readonly<{
    job_id: string;
    review_id: string;
    workgroup_id: string;
  }>;
  readonly supervisor_evaluation_submitted: Readonly<{
    evaluation_id: string;
    job_id: string;
    participant_id: string;
  }>;
  readonly review_response_created: Readonly<{
    job_id: string;
    review_id: string;
  }>;
  readonly review_report_created: AnalyticsReportContext;
  readonly dispute_opened: Readonly<{
    dispute_id: string;
    job_id: string;
    reason_code: string;
  }>;
  readonly dispute_closed: Readonly<{
    dispute_id: string;
    job_id: string;
    outcome_code: string;
  }>;
  readonly report_created: Readonly<{
    reason_code: string;
    report_id: string;
    target_type: string;
  }>;
  readonly moderation_action_applied: Readonly<{
    action_code: string;
    reason_code: string;
    target_type: string;
  }>;
  readonly notification_created: AnalyticsNotificationIdentity;
  readonly notification_delivery_succeeded: AnalyticsNotificationIdentity;
  readonly notification_delivery_failed: AnalyticsNotificationIdentity;
  readonly notification_in_app_read: AnalyticsNotificationIdentity;
  readonly notification_deep_link_opened: AnalyticsNotificationIdentity;
};

export type AnalyticsResultCountBucket = "ZERO" | "ONE_TO_FOUR" | "FIVE_PLUS";
export type AnalyticsAvailabilityCountBucket =
  "NOT_APPLICABLE" | AnalyticsResultCountBucket;
export type AnalyticsLocationScope = "NONE" | "MUNICIPALITY_SELECTED";
export type AnalyticsLocationAreaGranularity = "DISTRICT" | "REGION";
export type AnalyticsSearchSortMode = "RECOMMENDED" | "NEAREST" | "BEST_RATED";
export type AnalyticsCtaOrigin = "PUBLIC_PROFILE" | "SEARCH_RESULTS";
export type AnalyticsShortlistSizeBucket =
  "ZERO" | "ONE" | "TWO_TO_FOUR" | "FIVE_TO_NINE" | "TEN_PLUS";
export type AnalyticsPhotoCountBucket = "NONE" | "ONE_TO_FOUR" | "FIVE_TO_TEN";
export type AnalyticsAttachmentCountBucket =
  "ONE" | "TWO_TO_FOUR" | "FIVE_TO_TEN";
export type AnalyticsAttachmentTypeBucket = "IMAGE" | "PDF" | "MIXED";
export type AnalyticsMaterialRevisionCountBucket = "ONE" | "TWO" | "THREE_PLUS";
export type AnalyticsMessageCountBucket =
  "TWO_TO_FOUR" | "FIVE_TO_NINE" | "TEN_PLUS";
export type AnalyticsTimingOption =
  "AS_SOON_AS_POSSIBLE" | "SPECIFIC_PERIOD" | "FLEXIBLE" | "NOT_PROVIDED";
export type AnalyticsCancellationReason =
  "DUPLICATE" | "NO_LONGER_NEEDED" | "OTHER" | "PLANS_CHANGED";
export type AnalyticsDeclineReason =
  "NO_CAPACITY" | "NOT_MY_WORK" | "OTHER" | "TIMING" | "TOO_FAR";
export type AnalyticsInvitationWithdrawalSource =
  "CUSTOMER" | "CRAFTSMAN" | "REQUEST_CLOSED";
export type AnalyticsQuoteAuthoringMode =
  "PLATFORM_STRUCTURED" | "EXTERNAL_PDF";
export type AnalyticsQuoteDraftOrigin = "INITIAL" | "REVISION" | "RECONFIRM";
export type AnalyticsQuotePriceMode = "FIXED" | "ESTIMATE" | "RANGE";
export type AnalyticsProfileContextValue = "CUSTOMER" | "CRAFTSMAN";
export type AnalyticsEffectInitiator = "SYSTEM" | "USER";

type AnalyticsInvitationIdentity = Readonly<{
  invitation_id: string;
  job_request_id: string;
}>;
type AnalyticsQuoteIdentity = Readonly<{
  authoring_mode: AnalyticsQuoteAuthoringMode;
  job_request_id: string;
  price_mode?: AnalyticsQuotePriceMode;
  quote_id: string;
  quote_revision: number;
}>;
type AnalyticsJobIdentity = Readonly<{ job_id: string }>;
type AnalyticsParticipantIdentity = Readonly<{
  job_id: string;
  participant_id: string;
  role_code: string;
}>;
type AnalyticsMilestoneIdentity = Readonly<{
  job_id: string;
  milestone_id: string;
}>;
type AnalyticsChangeOrderIdentity = Readonly<{
  change_order_id: string;
  changed_material: boolean;
  changed_price: boolean;
  changed_schedule: boolean;
  changed_scope: boolean;
  job_id: string;
}>;
type AnalyticsCompletionIdentity = Readonly<{
  completion_attempt_id: string;
  job_id: string;
}>;
type AnalyticsReportContext = Readonly<{
  job_id: string;
  reason_code: string;
  target_type: string;
}>;
type AnalyticsNotificationIdentity = Readonly<{
  channel: string;
  notification_id: string;
  notification_type: string;
}>;

function definition(
  description: string,
  trigger: string,
  properties: Readonly<Record<string, AnalyticsPropertyRule>>,
  source: AnalyticsEventDefinition["source"] = "SERVER_DOMAIN",
  schemaVersion = 1,
): Readonly<AnalyticsEventDefinition> {
  return Object.freeze({
    description,
    properties: Object.freeze({ ...properties }),
    schema_version: schemaVersion,
    source,
    trigger,
  });
}

function quoteIdentityProperties(): Readonly<
  Record<string, AnalyticsPropertyRule>
> {
  return {
    authoring_mode: "AUTHORING_MODE",
    job_request_id: "UUID",
    price_mode: optional("PRICE_MODE"),
    quote_id: "UUID",
    quote_revision: "POSITIVE_INTEGER",
  };
}

function quoteTerminalDefinition(
  description: string,
  state: string,
  extra: Readonly<Record<string, AnalyticsPropertyRule>> = {},
): Readonly<AnalyticsEventDefinition> {
  return definition(
    `A submitted Quote revision was ${description}.`,
    `After the authoritative ${state} state effect commits.`,
    { ...quoteIdentityProperties(), ...extra },
  );
}

function changeOrderDefinition(
  description: string,
  state: string,
): Readonly<AnalyticsEventDefinition> {
  return definition(
    `A Change order ${description}.`,
    `After the authoritative ${state} Change-order effect commits.`,
    {
      change_order_id: "UUID",
      changed_material: "BOOLEAN",
      changed_price: "BOOLEAN",
      changed_schedule: "BOOLEAN",
      changed_scope: "BOOLEAN",
      job_id: "UUID",
    },
  );
}

function notificationDefinition(
  description: string,
  trigger: string,
  source: AnalyticsEventDefinition["source"] = "SERVER_DOMAIN",
): Readonly<AnalyticsEventDefinition> {
  return definition(
    description,
    trigger,
    {
      channel: "MACHINE_CODE",
      notification_id: "UUID",
      notification_type: "MACHINE_CODE",
    },
    source,
  );
}

function optional(kind: AnalyticsPropertyKind): AnalyticsPropertyRule {
  return Object.freeze({ kind, optional: true as const });
}
