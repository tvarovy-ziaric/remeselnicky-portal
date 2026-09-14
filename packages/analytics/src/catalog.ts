export const analyticsEventNames = [
  "public_profile_viewed",
  "registration_completed",
  "email_verification_completed",
  "phone_verification_completed",
  "job_request_submitted",
  "invitation_engaged",
  "quote_submitted",
  "quote_accepted",
  "job_confirmed",
  "job_completed",
  "review_submitted",
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];

export type AnalyticsPropertyRule = "UUID";

export interface AnalyticsEventDefinition {
  readonly description: string;
  readonly properties: Readonly<Record<string, AnalyticsPropertyRule>>;
  readonly schema_version: number;
  readonly source: "CLIENT_UX" | "SERVER_DOMAIN";
  readonly trigger: string;
}

/**
 * R0's deliberately small catalog covers only locked server-side conversion
 * milestones. UX events and the full alpha catalog belong to their feature
 * tickets and R4-027; callers cannot create ad-hoc names or properties here.
 */
export const analyticsEventCatalog = Object.freeze({
  public_profile_viewed: definition(
    "A public CraftsmanProfile was viewed.",
    "When an actually visible public profile view is accepted for UX analytics.",
    { craftsman_profile_id: "UUID" },
    "CLIENT_UX",
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
  job_request_submitted: definition(
    "A JobRequest entered its submitted state.",
    "After the JobRequest submission transaction commits.",
    { job_request_id: "UUID" },
  ),
  invitation_engaged: definition(
    "An invitation entered ENGAGED.",
    "After the invitation engagement transaction commits.",
    { invitation_id: "UUID", job_request_id: "UUID" },
  ),
  quote_submitted: definition(
    "A Quote revision was submitted.",
    "After the Quote submission transaction commits.",
    { job_request_id: "UUID", quote_id: "UUID" },
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
  job_completed: definition(
    "A Job reached its final COMPLETED state.",
    "After the completion transaction commits.",
    { job_id: "UUID" },
  ),
  review_submitted: definition(
    "An eligible verified-Job review was submitted.",
    "After the review submission transaction commits.",
    { job_id: "UUID", review_id: "UUID" },
  ),
} satisfies Readonly<Record<AnalyticsEventName, AnalyticsEventDefinition>>);

export type AnalyticsPropertiesByName = {
  readonly public_profile_viewed: Readonly<{
    craftsman_profile_id: string;
  }>;
  readonly registration_completed: Readonly<Record<string, never>>;
  readonly email_verification_completed: Readonly<Record<string, never>>;
  readonly phone_verification_completed: Readonly<Record<string, never>>;
  readonly job_request_submitted: Readonly<{ job_request_id: string }>;
  readonly invitation_engaged: Readonly<{
    invitation_id: string;
    job_request_id: string;
  }>;
  readonly quote_submitted: Readonly<{
    job_request_id: string;
    quote_id: string;
  }>;
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
  readonly job_completed: Readonly<{ job_id: string }>;
  readonly review_submitted: Readonly<{
    job_id: string;
    review_id: string;
  }>;
};

function definition(
  description: string,
  trigger: string,
  properties: Readonly<Record<string, AnalyticsPropertyRule>>,
  source: AnalyticsEventDefinition["source"] = "SERVER_DOMAIN",
): Readonly<AnalyticsEventDefinition> {
  return Object.freeze({
    description,
    properties: Object.freeze({ ...properties }),
    schema_version: 1,
    source,
    trigger,
  });
}
