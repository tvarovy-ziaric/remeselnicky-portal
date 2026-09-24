-- PostgreSQL enum values must be committed before the workflow migration can
-- safely use them. Reports remain claims; none of these values is a verdict.
ALTER TYPE moderation_report_target_type ADD VALUE 'CRAFTSMAN_PROFILE';
ALTER TYPE moderation_report_target_type ADD VALUE 'PORTFOLIO_PROJECT';
ALTER TYPE moderation_report_target_type ADD VALUE 'MEDIA_ASSET';
ALTER TYPE moderation_report_target_type ADD VALUE 'JOB_CONTEXT_REVIEW';
ALTER TYPE moderation_report_target_type ADD VALUE 'MESSAGE';
ALTER TYPE moderation_report_target_type ADD VALUE 'CONVERSATION';
ALTER TYPE moderation_report_target_type ADD VALUE 'JOB_ATTACHMENT';
ALTER TYPE moderation_report_target_type ADD VALUE 'JOB_REQUEST';
ALTER TYPE moderation_report_target_type ADD VALUE 'USER_BEHAVIOR';

ALTER TYPE moderation_report_reason ADD VALUE 'SPAM_SCAM';
ALTER TYPE moderation_report_reason ADD VALUE 'INAPPROPRIATE_CONTENT';
ALTER TYPE moderation_report_reason ADD VALUE 'IMPERSONATION_MISREPRESENTATION';
ALTER TYPE moderation_report_reason ADD VALUE 'FRAUD';
ALTER TYPE moderation_report_reason ADD VALUE 'ILLEGAL_SUSPICIOUS_ACTIVITY';
ALTER TYPE moderation_report_reason ADD VALUE 'CONTACT_BYPASS_ABUSE';
ALTER TYPE moderation_report_reason ADD VALUE 'FALSE_QUALIFICATION';
ALTER TYPE moderation_report_reason ADD VALUE 'FALSE_IDENTITY';
ALTER TYPE moderation_report_reason ADD VALUE 'MISLEADING_CLAIM';
ALTER TYPE moderation_report_reason ADD VALUE 'NOT_THEIR_WORK';
ALTER TYPE moderation_report_reason ADD VALUE 'CUSTOMER_PRIVACY';
ALTER TYPE moderation_report_reason ADD VALUE 'STOLEN_IMAGES';
ALTER TYPE moderation_report_reason ADD VALUE 'THREATS';
ALTER TYPE moderation_report_reason ADD VALUE 'PLATFORM_BYPASS_ATTEMPT';
ALTER TYPE moderation_report_reason ADD VALUE 'SUSPICIOUS_PAYMENT_SCAM';
