ALTER TYPE taxonomy_alias_target_kind ADD VALUE IF NOT EXISTS 'SERVICE';

ALTER TABLE taxonomy_aliases
DROP CONSTRAINT taxonomy_alias_target_code_safe;

ALTER TABLE taxonomy_aliases
ADD CONSTRAINT taxonomy_alias_target_code_safe CHECK (
  target_code ~ '^(PROF|SPEC|SERV|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
);
