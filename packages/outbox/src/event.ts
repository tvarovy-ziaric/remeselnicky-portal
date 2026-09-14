const domainEventBrand = Symbol("portal.outbox.domain-event");
const eventNamePattern = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/u;
const entityTypePattern = /^[A-Z][A-Z0-9_]{0,79}$/u;
const safeMachineValuePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const forbiddenPayloadKeys = new Set([
  "address",
  "body",
  "chat_text",
  "content",
  "cookie",
  "coordinates",
  "description",
  "dispute_text",
  "email",
  "exact_address",
  "filename",
  "latitude",
  "longitude",
  "message_text",
  "otp",
  "password",
  "phone",
  "quote_text",
  "review_text",
  "secret",
  "token",
]);

export type EventPayloadScalar = boolean | number | string | null;
export type EventPayloadValue =
  EventPayloadScalar | readonly EventPayloadScalar[];
export type EventPayload = Readonly<Record<string, EventPayloadValue>>;

export interface DomainEventEntity {
  /** Stable domain entity type, never a user-supplied label. */
  readonly type: string;
  /** Opaque identifier only; it grants no authorization. */
  readonly id: string;
}

export interface PersistedDomainEvent<
  Name extends string = string,
  Payload = EventPayload,
> {
  readonly entity?: DomainEventEntity;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly name: Name;
  readonly occurredAt: Date;
  readonly payload: Payload;
  readonly schemaVersion: number;
}

export interface DomainEvent<
  Name extends string = string,
  Payload = EventPayload,
> extends PersistedDomainEvent<Name, Payload> {
  readonly [domainEventBrand]: true;
}

export interface DomainEventDefinition<
  Name extends string,
  Keys extends readonly string[],
> {
  readonly eventName: Name;
  readonly maxPayloadBytes?: number;
  readonly payloadKeys: Keys;
  readonly schemaVersion: number;
}

export interface DomainEventInput<Keys extends readonly string[]> {
  readonly entity?: DomainEventEntity;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<Partial<Record<Keys[number], EventPayloadValue>>>;
}

export interface DefinedDomainEvent<
  Name extends string,
  Keys extends readonly string[],
> {
  create(
    input: DomainEventInput<Keys>,
  ): DomainEvent<
    Name,
    Readonly<Partial<Record<Keys[number], EventPayloadValue>>>
  >;
  readonly eventName: Name;
  readonly payloadKeys: Keys;
  readonly schemaVersion: number;
}

export function defineDomainEvent<
  const Name extends string,
  const Keys extends readonly string[],
>(
  definition: DomainEventDefinition<Name, Keys>,
): DefinedDomainEvent<Name, Keys> {
  assertEventName(definition.eventName);
  assertSchemaVersion(definition.schemaVersion);
  const allowedKeys = validatePayloadKeys(definition.payloadKeys);
  const maxPayloadBytes = definition.maxPayloadBytes ?? 8_192;
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 2 ||
    maxPayloadBytes > 8_192
  ) {
    throw new RangeError("maxPayloadBytes must be between 2 and 8192");
  }

  return Object.freeze({
    create(input: DomainEventInput<Keys>) {
      assertUuid(input.eventId, "eventId");
      assertSafeOpaqueIdentifier(input.idempotencyKey, "idempotencyKey", 256);
      if (
        !(input.occurredAt instanceof Date) ||
        !Number.isFinite(input.occurredAt.getTime())
      ) {
        throw new TypeError("occurredAt must be a valid server timestamp");
      }
      if (input.entity !== undefined) validateEntity(input.entity);

      const payload = validatePayload(
        input.payload,
        allowedKeys,
        maxPayloadBytes,
      ) as Readonly<Partial<Record<Keys[number], EventPayloadValue>>>;
      const entity =
        input.entity === undefined
          ? {}
          : { entity: Object.freeze({ ...input.entity }) };
      return Object.freeze({
        [domainEventBrand]: true as const,
        ...entity,
        eventId: input.eventId,
        idempotencyKey: input.idempotencyKey,
        name: definition.eventName,
        occurredAt: new Date(input.occurredAt),
        payload,
        schemaVersion: definition.schemaVersion,
      });
    },
    eventName: definition.eventName,
    payloadKeys: Object.freeze([...definition.payloadKeys]) as Keys,
    schemaVersion: definition.schemaVersion,
  });
}

export function isDomainEvent(value: unknown): value is DomainEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    domainEventBrand in value &&
    value[domainEventBrand] === true
  );
}

export function assertDomainEvent(
  value: unknown,
): asserts value is DomainEvent {
  if (!isDomainEvent(value)) {
    throw new TypeError(
      "Outbox accepts only events created by an explicit domain-event definition",
    );
  }
}

function validatePayload(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  maxPayloadBytes: number,
): EventPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("event payload must be a plain allowlisted object");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("event payload must be a plain allowlisted object");
  }

  const payload: Record<string, EventPayloadValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`event payload key is not allowlisted: ${key}`);
    }
    payload[key] = validatePayloadValue(item, key);
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > maxPayloadBytes) {
    throw new RangeError("event payload exceeds its schema byte limit");
  }
  return Object.freeze(payload);
}

function validatePayloadValue(value: unknown, key: string): EventPayloadValue {
  if (Array.isArray(value)) {
    if (value.length > 64) {
      throw new RangeError(`event payload array is too large: ${key}`);
    }
    return Object.freeze(value.map((item) => validateScalar(item, key)));
  }
  return validateScalar(value, key);
}

function validateScalar(value: unknown, key: string): EventPayloadScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && safeMachineValuePattern.test(value)) {
    return value;
  }
  throw new TypeError(
    `event payload values must be privacy-safe machine scalars, not content: ${key}`,
  );
}

function validatePayloadKeys(keys: readonly string[]): ReadonlySet<string> {
  if (keys.length > 64 || new Set(keys).size !== keys.length) {
    throw new TypeError(
      "payloadKeys must be unique and contain at most 64 keys",
    );
  }
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) {
      throw new TypeError("payloadKeys must use stable snake_case identifiers");
    }
    if (forbiddenPayloadKeys.has(key)) {
      throw new TypeError(`sensitive payload key is forbidden: ${key}`);
    }
  }
  return new Set(keys);
}

function validateEntity(entity: DomainEventEntity): void {
  if (!entityTypePattern.test(entity.type)) {
    throw new TypeError("entity type must be a stable uppercase identifier");
  }
  assertSafeOpaqueIdentifier(entity.id, "entity id", 128);
}

function assertEventName(name: string): void {
  if (name.length > 128 || !eventNamePattern.test(name)) {
    throw new TypeError("event name must be a stable bounded identifier");
  }
}

function assertSchemaVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > 32_767) {
    throw new RangeError("schemaVersion must be a positive small integer");
  }
}

function assertUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) throw new TypeError(`${label} must be a UUID`);
}

function assertSafeOpaqueIdentifier(
  value: string,
  label: string,
  maximum: number,
): void {
  if (value.length > maximum || !safeMachineValuePattern.test(value)) {
    throw new TypeError(`${label} must be an opaque safe identifier`);
  }
}
