"use client";

import React, { useEffect, useRef, useState } from "react";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Dict = Record<string, unknown>;
type Role = "MEMBER" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";
type EditableRole = Exclude<Role, "MEMBER">;
type RoleAction = "ASSIGN" | "REVOKE";
type State = "INVITED" | "ACCEPTED" | "DECLINED" | "LEFT" | "REMOVED";

export interface JobRosterParticipant {
  readonly id: string;
  readonly craftsmanProfileId: string;
  readonly displayName: string;
  readonly state: State;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
  readonly leftAt: string | null;
  readonly roles: readonly {
    readonly role: Role;
    readonly assignedAt: string;
    readonly endedAt: string | null;
    readonly active: boolean;
  }[];
  readonly workGroups: readonly {
    readonly assignmentId: string;
    readonly workGroupId: string;
    readonly name: string;
    readonly crewName: string | null;
    readonly assignedAt: string;
    readonly endedAt: string | null;
    readonly active: boolean;
  }[];
}

export interface JobRosterPage {
  readonly role: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly participants: readonly JobRosterParticipant[];
  readonly nextCursor: {
    readonly invitedAt: string;
    readonly id: string;
  } | null;
}

const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Dict, names: readonly string[]): boolean =>
  Object.keys(value).length === names.length &&
  Object.keys(value).every((key) => names.includes(key));
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown): value is string | null =>
  value === null || date(value);
const name = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const notBefore = (later: string | null, earlier: string): boolean =>
  later === null || Date.parse(later) >= Date.parse(earlier);

function validRole(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["role", "assignedAt", "endedAt", "active"]) &&
    ["MEMBER", "LEAD", "COORDINATOR", "SITE_MANAGER"].includes(
      value.role as string,
    ) &&
    date(value.assignedAt) &&
    nullableDate(value.endedAt) &&
    typeof value.active === "boolean" &&
    value.active === (value.endedAt === null) &&
    notBefore(value.endedAt, value.assignedAt)
  );
}

function validWorkGroup(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "assignmentId",
      "workGroupId",
      "name",
      "crewName",
      "assignedAt",
      "endedAt",
      "active",
    ]) &&
    typeof value.assignmentId === "string" &&
    uuid.test(value.assignmentId) &&
    typeof value.workGroupId === "string" &&
    uuid.test(value.workGroupId) &&
    name(value.name) &&
    (value.crewName === null || name(value.crewName)) &&
    date(value.assignedAt) &&
    nullableDate(value.endedAt) &&
    typeof value.active === "boolean" &&
    value.active === (value.endedAt === null) &&
    notBefore(value.endedAt, value.assignedAt)
  );
}

function validParticipant(value: unknown): value is JobRosterParticipant {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "craftsmanProfileId",
      "displayName",
      "state",
      "invitedAt",
      "acceptedAt",
      "leftAt",
      "roles",
      "workGroups",
    ]) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    typeof value.craftsmanProfileId !== "string" ||
    !uuid.test(value.craftsmanProfileId) ||
    !name(value.displayName) ||
    !["INVITED", "ACCEPTED", "DECLINED", "LEFT", "REMOVED"].includes(
      value.state as string,
    ) ||
    !date(value.invitedAt) ||
    !nullableDate(value.acceptedAt) ||
    !nullableDate(value.leftAt) ||
    !Array.isArray(value.roles) ||
    value.roles.length > 50 ||
    !value.roles.every(validRole) ||
    !Array.isArray(value.workGroups) ||
    value.workGroups.length > 50 ||
    !value.workGroups.every(validWorkGroup)
  )
    return false;
  if (
    (value.state === "INVITED" || value.state === "DECLINED") &&
    (value.acceptedAt !== null ||
      value.leftAt !== null ||
      value.roles.length > 0 ||
      value.workGroups.length > 0)
  )
    return false;
  if (
    (value.state === "ACCEPTED" ||
      value.state === "LEFT" ||
      value.state === "REMOVED") &&
    (value.acceptedAt === null || !notBefore(value.acceptedAt, value.invitedAt))
  )
    return false;
  if (value.state === "ACCEPTED" && value.leftAt !== null) return false;
  if (
    (value.state === "LEFT" || value.state === "REMOVED") &&
    (value.leftAt === null ||
      (value.acceptedAt !== null && !notBefore(value.leftAt, value.acceptedAt)))
  )
    return false;
  return true;
}

export function parseJobRosterPage(value: unknown): JobRosterPage | null {
  if (
    !record(value) ||
    !exactKeys(value, ["role", "participants", "nextCursor"]) ||
    (value.role !== "CUSTOMER" && value.role !== "PRIMARY_PROVIDER") ||
    !Array.isArray(value.participants) ||
    value.participants.length > 20 ||
    !value.participants.every(validParticipant) ||
    (value.role === "CUSTOMER" &&
      value.participants.some(
        (participant: JobRosterParticipant) =>
          participant.state === "INVITED" || participant.state === "DECLINED",
      ))
  )
    return null;
  const ids = new Set(
    value.participants.map((item: JobRosterParticipant) => item.id),
  );
  if (ids.size !== value.participants.length) return null;
  const assignmentIds = value.participants.flatMap(
    (item: JobRosterParticipant) =>
      item.workGroups.map((group) => group.assignmentId),
  );
  if (new Set(assignmentIds).size !== assignmentIds.length) return null;
  const cursor = value.nextCursor;
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exactKeys(cursor, ["invitedAt", "id"]) ||
      !date(cursor.invitedAt) ||
      typeof cursor.id !== "string" ||
      !uuid.test(cursor.id))
  )
    return null;
  return value as unknown as JobRosterPage;
}

export async function loadJobRosterPage(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly cursor?: JobRosterPage["nextCursor"];
}): Promise<JobRosterPage | null> {
  if (!uuid.test(input.jobId)) return null;
  const query = new URLSearchParams({ limit: "20" });
  if (input.cursor) {
    query.set("beforeAt", input.cursor.invitedAt);
    query.set("beforeId", input.cursor.id);
  }
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/roster?${query.toString()}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    return response.ok ? parseJobRosterPage(await response.json()) : null;
  } catch {
    return null;
  }
}

export interface JobWorkGroupListPage {
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly crewName: string | null;
    readonly createdAt: string;
  }[];
  readonly nextCursor: {
    readonly createdAt: string;
    readonly id: string;
  } | null;
}

export function parseJobWorkGroupListPage(
  value: unknown,
): JobWorkGroupListPage | null {
  if (
    !record(value) ||
    !exactKeys(value, ["groups", "nextCursor"]) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 50
  )
    return null;
  const ids = new Set<string>();
  for (const group of value.groups as unknown[]) {
    if (
      !record(group) ||
      !exactKeys(group, ["id", "name", "crewName", "createdAt"]) ||
      typeof group.id !== "string" ||
      !uuid.test(group.id) ||
      ids.has(group.id) ||
      typeof group.name !== "string" ||
      !workGroupName(group.name) ||
      (group.crewName !== null &&
        (typeof group.crewName !== "string" ||
          !workGroupName(group.crewName))) ||
      !date(group.createdAt)
    )
      return null;
    ids.add(group.id);
  }
  const cursor = value.nextCursor;
  const last: unknown = value.groups.at(-1);
  if (
    cursor !== null &&
    (!record(cursor) ||
      !exactKeys(cursor, ["createdAt", "id"]) ||
      !date(cursor.createdAt) ||
      typeof cursor.id !== "string" ||
      !uuid.test(cursor.id) ||
      !record(last) ||
      cursor.id !== last.id ||
      cursor.createdAt !== last.createdAt)
  )
    return null;
  return value as unknown as JobWorkGroupListPage;
}

export async function loadJobWorkGroupListPage(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly cursor?: JobWorkGroupListPage["nextCursor"];
}): Promise<JobWorkGroupListPage | null> {
  if (!uuid.test(input.jobId)) return null;
  const query = new URLSearchParams({ limit: "50" });
  if (input.cursor) {
    if (!date(input.cursor.createdAt) || !uuid.test(input.cursor.id))
      return null;
    query.set("beforeAt", input.cursor.createdAt);
    query.set("beforeId", input.cursor.id);
  }
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/work-groups?${query.toString()}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    return response.ok
      ? parseJobWorkGroupListPage(await response.json())
      : null;
  } catch {
    return null;
  }
}

export type JobParticipantRoleResult =
  | { readonly status: "OK"; readonly active: boolean }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" };

export async function sendJobParticipantRoleCommand(input: {
  readonly fetch: typeof fetch;
  readonly participantId: string;
  readonly commandId: string;
  readonly role: EditableRole;
  readonly action: RoleAction;
}): Promise<JobParticipantRoleResult> {
  if (
    !uuid.test(input.participantId) ||
    !uuid.test(input.commandId) ||
    !(["LEAD", "COORDINATOR", "SITE_MANAGER"] as const).includes(input.role) ||
    (input.action !== "ASSIGN" && input.action !== "REVOKE")
  )
    return { status: "UNAVAILABLE" };
  try {
    const csrfResponse = await input.fetch.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return { status: "AUTH_REQUIRED" };
    if (!csrfResponse.ok) return { status: "UNAVAILABLE" };
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exactKeys(csrf, ["csrfToken"]) ||
      typeof csrf.csrfToken !== "string" ||
      csrf.csrfToken.length < 1 ||
      csrf.csrfToken.length > 1_000
    )
      return { status: "UNAVAILABLE" };
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-participations/${input.participantId}/roles`,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          role: input.role,
          action: input.action,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !exactKeys(body, ["status", "role", "active", "recordedAt"]) ||
      (body.status !== "APPLIED" && body.status !== "DEDUPLICATED") ||
      body.role !== input.role ||
      body.active !== (input.action === "ASSIGN") ||
      !date(body.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "OK", active: input.action === "ASSIGN" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function getRoleCommandId(
  attempts: Map<string, string>,
  participantId: string,
  role: EditableRole,
  action: RoleAction,
  generateId: () => string,
): string | null {
  const key = `${participantId}:${role}:${action}`;
  const existing = attempts.get(key);
  if (existing) return existing;
  const commandId = generateId();
  if (!uuid.test(commandId)) return null;
  attempts.set(key, commandId);
  return commandId;
}

export type JobWorkGroupCommandResult =
  | { readonly status: "CREATED"; readonly workGroupId: string }
  | { readonly status: "ASSIGNED"; readonly assignmentId: string }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" };

const workGroupName = (value: string): boolean =>
  value === value.trim() &&
  value.length >= 2 &&
  value.length <= 120 &&
  !/[\p{Cc}]/u.test(value);

async function loadCsrfToken(
  fetcher: typeof fetch,
): Promise<
  | { readonly status: "OK"; readonly token: string }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" }
> {
  const response = await fetcher.call(globalThis, "/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401) return { status: "AUTH_REQUIRED" };
  if (!response.ok) return { status: "UNAVAILABLE" };
  const value: unknown = await response.json();
  return record(value) &&
    exactKeys(value, ["csrfToken"]) &&
    typeof value.csrfToken === "string" &&
    value.csrfToken.length >= 1 &&
    value.csrfToken.length <= 1_000
    ? { status: "OK", token: value.csrfToken }
    : { status: "UNAVAILABLE" };
}

export async function createJobWorkGroup(input: {
  readonly fetch: typeof fetch;
  readonly jobId: string;
  readonly commandId: string;
  readonly name: string;
}): Promise<JobWorkGroupCommandResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.commandId) ||
    !workGroupName(input.name)
  )
    return { status: "UNAVAILABLE" };
  try {
    const csrf = await loadCsrfToken(input.fetch);
    if (csrf.status !== "OK") return csrf;
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/work-groups`,
      {
        body: JSON.stringify({ commandId: input.commandId, name: input.name }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.token,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !exactKeys(body, ["status", "workGroupId", "createdAt"]) ||
      (body.status !== "APPLIED" && body.status !== "DEDUPLICATED") ||
      typeof body.workGroupId !== "string" ||
      !uuid.test(body.workGroupId) ||
      !date(body.createdAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "CREATED", workGroupId: body.workGroupId };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export async function assignJobWorkGroupParticipant(input: {
  readonly fetch: typeof fetch;
  readonly workGroupId: string;
  readonly participantId: string;
  readonly commandId: string;
}): Promise<JobWorkGroupCommandResult> {
  if (
    !uuid.test(input.workGroupId) ||
    !uuid.test(input.participantId) ||
    !uuid.test(input.commandId)
  )
    return { status: "UNAVAILABLE" };
  try {
    const csrf = await loadCsrfToken(input.fetch);
    if (csrf.status !== "OK") return csrf;
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-work-groups/${input.workGroupId}/assignments`,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          participantId: input.participantId,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.token,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !exactKeys(body, ["status", "assignmentId", "assignedAt"]) ||
      (body.status !== "APPLIED" && body.status !== "DEDUPLICATED") ||
      typeof body.assignmentId !== "string" ||
      !uuid.test(body.assignmentId) ||
      !date(body.assignedAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "ASSIGNED", assignmentId: body.assignmentId };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export function getWorkGroupCommandId(
  attempts: Map<string, string>,
  intent: string,
  generateId: () => string,
): string | null {
  const existing = attempts.get(intent);
  if (existing) return existing;
  const commandId = generateId();
  if (!uuid.test(commandId)) return null;
  attempts.set(intent, commandId);
  return commandId;
}

const removalReason = (value: string): boolean =>
  value === value.trim() &&
  value.length >= 8 &&
  value.length <= 500 &&
  !/[\p{Cc}]/u.test(value);

export function getWorkGroupRemovalCommandId(
  attempts: Map<
    string,
    { readonly reason: string; readonly commandId: string }
  >,
  assignmentId: string,
  reason: string,
  generateId: () => string,
): string | null {
  const existing = attempts.get(assignmentId);
  if (existing) return existing.reason === reason ? existing.commandId : null;
  if (!uuid.test(assignmentId) || !removalReason(reason)) return null;
  const commandId = generateId();
  if (!uuid.test(commandId)) return null;
  attempts.set(assignmentId, { reason, commandId });
  return commandId;
}

export async function removeJobWorkGroupAssignment(input: {
  readonly fetch: typeof fetch;
  readonly assignmentId: string;
  readonly commandId: string;
  readonly reason: string;
}): Promise<
  | { readonly status: "REMOVED"; readonly endedAt: string }
  | { readonly status: "AUTH_REQUIRED" | "UNAVAILABLE" }
> {
  if (
    !uuid.test(input.assignmentId) ||
    !uuid.test(input.commandId) ||
    !removalReason(input.reason)
  )
    return { status: "UNAVAILABLE" };
  try {
    const csrf = await loadCsrfToken(input.fetch);
    if (csrf.status !== "OK") return csrf;
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/job-work-group-assignments/${input.assignmentId}/departure`,
      {
        body: JSON.stringify({
          commandId: input.commandId,
          action: "REMOVE",
          reason: input.reason,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf.token,
        },
        method: "POST",
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !exactKeys(body, ["status", "endedAt"]) ||
      (body.status !== "APPLIED" && body.status !== "DEDUPLICATED") ||
      !date(body.endedAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "REMOVED", endedAt: body.endedAt };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

const editableRoles: readonly EditableRole[] = [
  "LEAD",
  "COORDINATOR",
  "SITE_MANAGER",
];

const roleLabel: Readonly<Record<Role, string>> = {
  MEMBER: "Člen",
  LEAD: "Vedúci skupiny",
  COORDINATOR: "Koordinátor",
  SITE_MANAGER: "Stavbyvedúci",
};
const timestamp = (value: string): string =>
  new Date(value).toLocaleDateString("sk-SK");

interface WorkGroupOption {
  readonly id: string;
  readonly name: string;
  readonly crewName: string | null;
  readonly activeMemberNames: readonly string[];
  readonly historicalMemberCount: number;
}

export function deriveWorkGroupOptions(
  page: JobRosterPage,
  identities: JobWorkGroupListPage["groups"],
): readonly WorkGroupOption[] {
  const groups = new Map<
    string,
    {
      id: string;
      name: string;
      crewName: string | null;
      activeMemberNames: string[];
      historicalMemberCount: number;
    }
  >();
  for (const identity of identities)
    groups.set(identity.id, {
      id: identity.id,
      name: identity.name,
      crewName: identity.crewName,
      activeMemberNames: [],
      historicalMemberCount: 0,
    });
  for (const participant of page.participants)
    for (const assignment of participant.workGroups) {
      const group = groups.get(assignment.workGroupId);
      if (!group) continue;
      if (assignment.active && participant.state === "ACCEPTED")
        group.activeMemberNames.push(participant.displayName);
      else group.historicalMemberCount += 1;
    }
  return [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name, "sk-SK") || a.id.localeCompare(b.id),
  );
}

function JobWorkGroupControls({
  page,
  workGroups,
  disabled,
  onCreate,
  onAssign,
}: {
  page: JobRosterPage;
  workGroups: JobWorkGroupListPage["groups"];
  disabled: boolean;
  onCreate: (name: string) => Promise<boolean>;
  onAssign: (workGroupId: string, participantId: string) => Promise<boolean>;
}) {
  const [newName, setNewName] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const groups = deriveWorkGroupOptions(page, workGroups);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const eligibleParticipants = selectedGroup
    ? page.participants.filter(
        (participant) =>
          participant.state === "ACCEPTED" &&
          !participant.workGroups.some(
            (assignment) =>
              assignment.workGroupId === selectedGroupId && assignment.active,
          ),
      )
    : [];
  const selectedParticipant = eligibleParticipants.find(
    (participant) => participant.id === selectedParticipantId,
  );
  return (
    <section
      className="job-work-group-controls"
      aria-labelledby="job-work-groups"
    >
      <h3 id="job-work-groups">Pracovné skupiny zákazky</h3>
      <p>
        Tieto skupiny patria ku konkrétnej zákazke. Členstvo v opakovane
        používanej Crew sa nepreberá automaticky a samotné zaradenie nenahrádza
        prijatie účasti.
      </p>
      {groups.length === 0 ? (
        <p>Zatiaľ nie je vytvorená pracovná skupina.</p>
      ) : (
        <ul className="job-work-group-list">
          {groups.map((group) => (
            <li key={group.id}>
              <strong>{group.name}</strong>
              {group.crewName && <span> · Crew: {group.crewName}</span>}
              <p>
                Aktuálne priradení z načítaných účastníkov:{" "}
                {group.activeMemberNames.length === 0
                  ? "nikto"
                  : group.activeMemberNames.join(", ")}
                {group.historicalMemberCount > 0 &&
                  ` · Historické priradenia z načítaných účastníkov: ${group.historicalMemberCount}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = newName.trim();
          if (!workGroupName(normalized) || disabled) return;
          void onCreate(normalized).then((succeeded) => {
            if (succeeded) setNewName("");
          });
        }}
      >
        <label htmlFor="new-job-work-group-name">Názov novej skupiny</label>
        <input
          disabled={disabled}
          id="new-job-work-group-name"
          maxLength={120}
          onChange={(event) => setNewName(event.target.value)}
          required
          value={newName}
        />
        <button
          disabled={disabled || !workGroupName(newName.trim())}
          type="submit"
        >
          Vytvoriť skupinu
        </button>
      </form>
      {groups.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedGroup || !selectedParticipant || disabled) return;
            void onAssign(selectedGroup.id, selectedParticipant.id).then(
              (succeeded) => {
                if (succeeded) setSelectedParticipantId("");
              },
            );
          }}
        >
          <label htmlFor="job-work-group-selection">Pracovná skupina</label>
          <select
            disabled={disabled}
            id="job-work-group-selection"
            onChange={(event) => {
              setSelectedGroupId(event.target.value);
              setSelectedParticipantId("");
            }}
            value={selectedGroupId}
          >
            <option value="">Vyberte skupinu</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          <label htmlFor="job-work-group-participant">Potvrdený účastník</label>
          <select
            disabled={disabled || !selectedGroup}
            id="job-work-group-participant"
            onChange={(event) => setSelectedParticipantId(event.target.value)}
            value={selectedParticipantId}
          >
            <option value="">Vyberte účastníka</option>
            {eligibleParticipants.map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.displayName}
              </option>
            ))}
          </select>
          <button
            disabled={disabled || !selectedGroup || !selectedParticipant}
            type="submit"
          >
            Priradiť do skupiny
          </button>
        </form>
      )}
    </section>
  );
}

function ParticipantCard({
  participant,
  jobCancelled = false,
  jobCompleted = false,
  capabilityLink = false,
  onRoleAction,
  rolesDisabled = false,
  onGroupRemove,
  removalLocks = {},
  groupsDisabled = false,
}: {
  participant: JobRosterParticipant;
  jobCancelled?: boolean;
  jobCompleted?: boolean;
  capabilityLink?: boolean;
  onRoleAction?: (
    participantId: string,
    role: EditableRole,
    action: RoleAction,
  ) => void;
  rolesDisabled?: boolean;
  onGroupRemove?: (assignmentId: string, reason: string) => Promise<boolean>;
  removalLocks?: Readonly<Record<string, string>>;
  groupsDisabled?: boolean;
}) {
  return (
    <li className="job-roster-card">
      <h4>{participant.displayName}</h4>
      <p>
        {participant.state === "ACCEPTED"
          ? jobCancelled
            ? "Potvrdená účasť na zrušenej zákazke"
            : jobCompleted
              ? "Potvrdená účasť na dokončenej zákazke"
              : "Potvrdený účastník"
          : participant.state === "LEFT"
            ? "Účasť ukončená odchodom"
            : participant.state === "REMOVED"
              ? "Účasť ukončená"
              : participant.state === "INVITED"
                ? "Pozvanie čaká na prijatie – nie je overenou účasťou"
                : "Pozvanie odmietnuté – bez overenej účasti"}
      </p>
      {participant.acceptedAt && (
        <p>
          Účasť potvrdená:{" "}
          <time dateTime={participant.acceptedAt}>
            {timestamp(participant.acceptedAt)}
          </time>
          {participant.leftAt && (
            <>
              {" "}
              · Ukončená:{" "}
              <time dateTime={participant.leftAt}>
                {timestamp(participant.leftAt)}
              </time>
            </>
          )}
        </p>
      )}
      {capabilityLink && participant.acceptedAt && (
        <p>
          <a href={`/ucasti/schopnosti/${participant.id}`}>
            Profesie a zručnosti na zákazke
          </a>
        </p>
      )}
      {participant.roles.length > 0 && (
        <div>
          <strong>Úlohy na zákazke</strong>
          <ul>
            {participant.roles.map((item, index) => (
              <li key={`${item.role}-${item.assignedAt}-${index}`}>
                {roleLabel[item.role]} · od{" "}
                <time dateTime={item.assignedAt}>
                  {timestamp(item.assignedAt)}
                </time>
                {item.endedAt && (
                  <>
                    {" "}
                    do{" "}
                    <time dateTime={item.endedAt}>
                      {timestamp(item.endedAt)}
                    </time>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {onRoleAction &&
        participant.state === "ACCEPTED" &&
        !jobCancelled &&
        !jobCompleted && (
          <div className="job-roster-role-controls">
            <strong>Roly na zákazke</strong>
            <p>
              Členstvo je súčasťou potvrdenej účasti; ďalšie roly možno prideliť
              súbežne.
            </p>
            <div>
              {editableRoles.map((role) => {
                const active = participant.roles.some(
                  (item) => item.role === role && item.active,
                );
                const action: RoleAction = active ? "REVOKE" : "ASSIGN";
                return (
                  <button
                    disabled={rolesDisabled}
                    key={role}
                    onClick={() => onRoleAction(participant.id, role, action)}
                    type="button"
                  >
                    {active ? "Odobrať rolu" : "Prideliť rolu"}{" "}
                    {roleLabel[role]}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      {participant.workGroups.length > 0 && (
        <div>
          <strong>Pracovné skupiny</strong>
          <ul>
            {participant.workGroups.map((group, index) => (
              <li key={`${group.workGroupId}-${group.assignedAt}-${index}`}>
                {group.name}
                {group.crewName && ` · Crew: ${group.crewName}`} · od{" "}
                <time dateTime={group.assignedAt}>
                  {timestamp(group.assignedAt)}
                </time>
                {group.endedAt && (
                  <>
                    {" "}
                    do{" "}
                    <time dateTime={group.endedAt}>
                      {timestamp(group.endedAt)}
                    </time>
                  </>
                )}
                {onGroupRemove &&
                  participant.state === "ACCEPTED" &&
                  group.active &&
                  !jobCancelled &&
                  !jobCompleted && (
                    <JobWorkGroupRemovalForm
                      assignmentId={group.assignmentId}
                      disabled={groupsDisabled}
                      {...(removalLocks[group.assignmentId] === undefined
                        ? {}
                        : { lockedReason: removalLocks[group.assignmentId] })}
                      onRemove={onGroupRemove}
                    />
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function JobWorkGroupRemovalForm({
  assignmentId,
  disabled,
  lockedReason,
  onRemove,
}: {
  assignmentId: string;
  disabled: boolean;
  lockedReason?: string;
  onRemove: (assignmentId: string, reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const effectiveReason = lockedReason ?? reason.trim();
  return (
    <form
      className="job-work-group-removal"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !removalReason(effectiveReason)) return;
        void onRemove(assignmentId, effectiveReason).then((succeeded) => {
          if (succeeded) setReason("");
        });
      }}
    >
      <label htmlFor={`job-work-group-remove-${assignmentId}`}>
        Dôvod ukončenia priradenia (8–500 znakov)
      </label>
      <textarea
        disabled={disabled || lockedReason !== undefined}
        id={`job-work-group-remove-${assignmentId}`}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        required
        value={lockedReason ?? reason}
      />
      {lockedReason !== undefined && (
        <p>Pri opakovaní neistého príkazu zostáva pôvodný dôvod nezmenený.</p>
      )}
      <button
        disabled={disabled || !removalReason(effectiveReason)}
        type="submit"
      >
        Odobrať zo skupiny
      </button>
    </form>
  );
}

export function JobRosterGroups({
  page,
  jobState,
  onRoleAction,
  rolesDisabled = false,
  workGroups,
  onGroupCreate,
  onGroupAssign,
  groupsDisabled = false,
  onGroupRemove,
  removalLocks = {},
}: {
  page: JobRosterPage;
  jobState:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
  onRoleAction?: (
    participantId: string,
    role: EditableRole,
    action: RoleAction,
  ) => void;
  rolesDisabled?: boolean;
  workGroups?: JobWorkGroupListPage["groups"];
  onGroupCreate?: (name: string) => Promise<boolean>;
  onGroupAssign?: (
    workGroupId: string,
    participantId: string,
  ) => Promise<boolean>;
  groupsDisabled?: boolean;
  onGroupRemove?: (assignmentId: string, reason: string) => Promise<boolean>;
  removalLocks?: Readonly<Record<string, string>>;
}) {
  const writable = jobState === "CONFIRMED" || jobState === "IN_PROGRESS";
  const closed = jobState === "CANCELLED" || jobState === "COMPLETED";
  const current = closed
    ? []
    : page.participants.filter((item) => item.state === "ACCEPTED");
  const historical = page.participants.filter((item) =>
    closed
      ? item.state === "ACCEPTED" ||
        item.state === "LEFT" ||
        item.state === "REMOVED"
      : item.state === "LEFT" || item.state === "REMOVED",
  );
  const pending =
    page.role === "PRIMARY_PROVIDER"
      ? page.participants.filter(
          (item) => item.state === "INVITED" || item.state === "DECLINED",
        )
      : [];
  return (
    <div className="job-roster-groups">
      {page.role === "PRIMARY_PROVIDER" &&
        writable &&
        workGroups &&
        onGroupCreate &&
        onGroupAssign && (
          <JobWorkGroupControls
            page={page}
            workGroups={workGroups}
            disabled={groupsDisabled}
            onCreate={onGroupCreate}
            onAssign={onGroupAssign}
          />
        )}
      {!closed && (
        <div>
          <h3>Aktuálni účastníci</h3>
          {current.length === 0 ? (
            <p>Na tejto stránke nie sú potvrdení ďalší účastníci.</p>
          ) : (
            <ul className="job-roster-list">
              {current.map((item) => (
                <ParticipantCard
                  key={item.id}
                  participant={item}
                  capabilityLink={page.role === "PRIMARY_PROVIDER"}
                  {...(page.role === "PRIMARY_PROVIDER" &&
                  writable &&
                  onRoleAction
                    ? { onRoleAction, rolesDisabled }
                    : {})}
                  {...(page.role === "PRIMARY_PROVIDER" &&
                  writable &&
                  onGroupRemove
                    ? { onGroupRemove, removalLocks, groupsDisabled }
                    : {})}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {historical.length > 0 && (
        <div>
          <h3>História účasti</h3>
          <ul className="job-roster-list">
            {historical.map((item) => (
              <ParticipantCard
                key={item.id}
                participant={item}
                jobCancelled={jobState === "CANCELLED"}
                jobCompleted={jobState === "COMPLETED"}
                capabilityLink={page.role === "PRIMARY_PROVIDER"}
              />
            ))}
          </ul>
        </div>
      )}
      {pending.length > 0 && (
        <div>
          <h3>Nepotvrdené pozvania</h3>
          <p>Tieto osoby sa nepočítajú ako overení účastníci zákazky.</p>
          <ul className="job-roster-list">
            {pending.map((item) => (
              <ParticipantCard key={item.id} participant={item} />
            ))}
          </ul>
        </div>
      )}
      {closed && historical.length === 0 && pending.length === 0 && (
        <p>Bez zaznamenanej účasti.</p>
      )}
    </div>
  );
}

export function JobRoster({
  jobId,
  jobState,
}: {
  jobId: string;
  jobState:
    | "CONFIRMED"
    | "IN_PROGRESS"
    | "COMPLETION_REQUESTED"
    | "COMPLETED"
    | "CANCELLED";
}) {
  const writable = jobState === "CONFIRMED" || jobState === "IN_PROGRESS";
  const [page, setPage] = useState<JobRosterPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [rolePending, setRolePending] = useState(false);
  const [roleMessage, setRoleMessage] = useState<string | null>(null);
  const [roleError, setRoleError] = useState(false);
  const [groupPending, setGroupPending] = useState(false);
  const [groupMessage, setGroupMessage] = useState<string | null>(null);
  const [groupError, setGroupError] = useState(false);
  const [groupPage, setGroupPage] = useState<JobWorkGroupListPage | null>(null);
  const [groupLoadFailed, setGroupLoadFailed] = useState(false);
  const [groupsLoadingMore, setGroupsLoadingMore] = useState(false);
  const [removalLocks, setRemovalLocks] = useState<
    Readonly<Record<string, string>>
  >({});
  const roleAttempts = useRef(new Map<string, string>());
  const roleInFlight = useRef(false);
  const groupAttempts = useRef(new Map<string, string>());
  const groupInFlight = useRef(false);
  const removeAttempts = useRef(
    new Map<string, { readonly reason: string; readonly commandId: string }>(),
  );
  useEffect(() => {
    let active = true;
    setPage(null);
    setFailed(false);
    setGroupPage(null);
    setGroupLoadFailed(false);
    groupAttempts.current.clear();
    removeAttempts.current.clear();
    setRemovalLocks({});
    void loadJobRosterPage({ fetch: globalThis.fetch, jobId }).then(
      (result) => {
        if (!active) return;
        setPage(result);
        setFailed(result === null);
        if (result?.role === "PRIMARY_PROVIDER" && writable)
          void loadJobWorkGroupListPage({
            fetch: globalThis.fetch,
            jobId,
          }).then((groups) => {
            if (!active) return;
            setGroupPage(groups);
            setGroupLoadFailed(groups === null);
          });
      },
    );
    return () => {
      active = false;
    };
  }, [jobId, jobState]);
  const more = async () => {
    if (
      !page?.nextCursor ||
      pending ||
      roleInFlight.current ||
      groupInFlight.current
    )
      return;
    setPending(true);
    const next = await loadJobRosterPage({
      fetch: globalThis.fetch,
      jobId,
      cursor: page.nextCursor,
    });
    if (
      next === null ||
      next.role !== page.role ||
      next.participants.some((item) =>
        page.participants.some((existing) => existing.id === item.id),
      )
    )
      setFailed(true);
    else
      setPage({
        role: page.role,
        participants: [...page.participants, ...next.participants],
        nextCursor: next.nextCursor,
      });
    setPending(false);
  };
  const moreGroups = async () => {
    if (
      !groupPage?.nextCursor ||
      groupsLoadingMore ||
      pending ||
      roleInFlight.current ||
      groupInFlight.current
    )
      return;
    setGroupsLoadingMore(true);
    const next = await loadJobWorkGroupListPage({
      fetch: globalThis.fetch,
      jobId,
      cursor: groupPage.nextCursor,
    });
    if (
      next === null ||
      next.groups.some((group) =>
        groupPage.groups.some((existing) => existing.id === group.id),
      )
    )
      setGroupLoadFailed(true);
    else
      setGroupPage({
        groups: [...groupPage.groups, ...next.groups],
        nextCursor: next.nextCursor,
      });
    setGroupsLoadingMore(false);
  };
  const changeRole = async (
    participantId: string,
    role: EditableRole,
    action: RoleAction,
  ) => {
    if (
      roleInFlight.current ||
      groupInFlight.current ||
      pending ||
      groupsLoadingMore ||
      !page ||
      page.role !== "PRIMARY_PROVIDER" ||
      !writable ||
      !page.participants.some(
        (item) =>
          item.id === participantId &&
          item.state === "ACCEPTED" &&
          item.roles.some((entry) => entry.role === role && entry.active) ===
            (action === "REVOKE"),
      )
    )
      return;
    const commandId = getRoleCommandId(
      roleAttempts.current,
      participantId,
      role,
      action,
      () => crypto.randomUUID(),
    );
    if (commandId === null) return;
    roleInFlight.current = true;
    setRolePending(true);
    setRoleMessage(null);
    setRoleError(false);
    const result = await sendJobParticipantRoleCommand({
      fetch: globalThis.fetch,
      participantId,
      commandId,
      role,
      action,
    });
    if (result.status === "OK") {
      roleAttempts.current.delete(`${participantId}:${role}:${action}`);
      setPage(null);
      setFailed(false);
      const loaded = await loadJobRosterPage({
        fetch: globalThis.fetch,
        jobId,
      });
      const refreshed = loaded?.role === "PRIMARY_PROVIDER" ? loaded : null;
      setPage(refreshed);
      setFailed(refreshed === null);
      setRoleError(refreshed === null);
      setRoleMessage(
        refreshed === null
          ? "Príkaz sa potvrdil, ale prehľad rolí sa nepodarilo obnoviť. Obnovte stránku."
          : "Rola bola aktualizovaná podľa nového prehľadu zákazky.",
      );
    } else {
      setRoleError(true);
      setRoleMessage(
        result.status === "AUTH_REQUIRED"
          ? "Platnosť prihlásenia vypršala. Prihláste sa a skúste to znova."
          : "Výsledok zmeny roly sa nepodarilo overiť. Zopakujte rovnakú akciu alebo obnovte stránku.",
      );
    }
    roleInFlight.current = false;
    setRolePending(false);
  };
  const createGroup = async (name: string): Promise<boolean> => {
    if (
      groupInFlight.current ||
      roleInFlight.current ||
      pending ||
      groupsLoadingMore ||
      !page ||
      !groupPage ||
      page.role !== "PRIMARY_PROVIDER" ||
      !writable ||
      !workGroupName(name)
    )
      return false;
    const intent = `create:${name}`;
    const commandId = getWorkGroupCommandId(groupAttempts.current, intent, () =>
      crypto.randomUUID(),
    );
    if (commandId === null) return false;
    groupInFlight.current = true;
    setGroupPending(true);
    setGroupMessage(null);
    setGroupError(false);
    const result = await createJobWorkGroup({
      fetch: globalThis.fetch,
      jobId,
      commandId,
      name,
    });
    const succeeded = result.status === "CREATED";
    if (result.status === "CREATED") {
      groupAttempts.current.delete(intent);
      const refreshed = await loadJobWorkGroupListPage({
        fetch: globalThis.fetch,
        jobId,
      });
      setGroupPage(refreshed);
      setGroupLoadFailed(refreshed === null);
      setGroupError(refreshed === null);
      setGroupMessage(
        refreshed === null
          ? "Skupina bola vytvorená, ale jej prehľad sa nepodarilo obnoviť. Obnovte stránku."
          : "Skupina bola vytvorená. Teraz do nej môžete priradiť potvrdeného účastníka.",
      );
    } else {
      setGroupError(true);
      setGroupMessage(
        result.status === "AUTH_REQUIRED"
          ? "Platnosť prihlásenia vypršala. Prihláste sa a skúste to znova."
          : "Výsledok vytvorenia skupiny sa nepodarilo overiť. Zopakujte rovnaký názov alebo obnovte stránku.",
      );
    }
    groupInFlight.current = false;
    setGroupPending(false);
    return succeeded;
  };
  const assignGroup = async (
    workGroupId: string,
    participantId: string,
  ): Promise<boolean> => {
    if (
      groupInFlight.current ||
      roleInFlight.current ||
      pending ||
      groupsLoadingMore ||
      !page ||
      !groupPage ||
      page.role !== "PRIMARY_PROVIDER" ||
      !writable ||
      !deriveWorkGroupOptions(page, groupPage.groups).some(
        (group) => group.id === workGroupId,
      ) ||
      !page.participants.some(
        (participant) =>
          participant.id === participantId &&
          participant.state === "ACCEPTED" &&
          !participant.workGroups.some(
            (assignment) =>
              assignment.workGroupId === workGroupId && assignment.active,
          ),
      )
    )
      return false;
    const intent = `assign:${workGroupId}:${participantId}`;
    const commandId = getWorkGroupCommandId(groupAttempts.current, intent, () =>
      crypto.randomUUID(),
    );
    if (commandId === null) return false;
    groupInFlight.current = true;
    setGroupPending(true);
    setGroupMessage(null);
    setGroupError(false);
    const result = await assignJobWorkGroupParticipant({
      fetch: globalThis.fetch,
      workGroupId,
      participantId,
      commandId,
    });
    if (result.status === "ASSIGNED") {
      groupAttempts.current.delete(intent);
      setPage(null);
      setFailed(false);
      const loaded = await loadJobRosterPage({
        fetch: globalThis.fetch,
        jobId,
      });
      const refreshed = loaded?.role === "PRIMARY_PROVIDER" ? loaded : null;
      setPage(refreshed);
      setFailed(refreshed === null);
      setGroupError(refreshed === null);
      setGroupMessage(
        refreshed === null
          ? "Priradenie sa potvrdilo, ale prehľad skupiny sa nepodarilo obnoviť. Obnovte stránku."
          : "Priradenie sa potvrdilo a prehľad skupiny bol obnovený.",
      );
    } else {
      setGroupError(true);
      setGroupMessage(
        result.status === "AUTH_REQUIRED"
          ? "Platnosť prihlásenia vypršala. Prihláste sa a skúste to znova."
          : "Výsledok priradenia sa nepodarilo overiť. Zopakujte rovnakú akciu alebo obnovte stránku.",
      );
    }
    groupInFlight.current = false;
    setGroupPending(false);
    return result.status === "ASSIGNED";
  };
  const removeGroup = async (
    assignmentId: string,
    reason: string,
  ): Promise<boolean> => {
    if (
      groupInFlight.current ||
      roleInFlight.current ||
      pending ||
      groupsLoadingMore ||
      !page ||
      page.role !== "PRIMARY_PROVIDER" ||
      !writable ||
      !removalReason(reason) ||
      !page.participants.some(
        (participant) =>
          participant.state === "ACCEPTED" &&
          participant.workGroups.some(
            (group) => group.assignmentId === assignmentId && group.active,
          ),
      )
    )
      return false;
    const commandId = getWorkGroupRemovalCommandId(
      removeAttempts.current,
      assignmentId,
      reason,
      () => crypto.randomUUID(),
    );
    if (commandId === null) {
      setGroupError(true);
      setGroupMessage(
        "Po neistom výsledku zopakujte odobratie s pôvodným dôvodom alebo obnovte stránku.",
      );
      return false;
    }
    setRemovalLocks((current) => ({ ...current, [assignmentId]: reason }));
    groupInFlight.current = true;
    setGroupPending(true);
    setGroupMessage(null);
    setGroupError(false);
    const result = await removeJobWorkGroupAssignment({
      fetch: globalThis.fetch,
      assignmentId,
      commandId,
      reason,
    });
    if (result.status === "REMOVED") {
      removeAttempts.current.delete(assignmentId);
      setRemovalLocks((current) => {
        const remaining = { ...current };
        delete remaining[assignmentId];
        return remaining;
      });
      setPage(null);
      setFailed(false);
      const loaded = await loadJobRosterPage({
        fetch: globalThis.fetch,
        jobId,
      });
      const refreshed = loaded?.role === "PRIMARY_PROVIDER" ? loaded : null;
      setPage(refreshed);
      setFailed(refreshed === null);
      setGroupError(refreshed === null);
      setGroupMessage(
        refreshed === null
          ? "Ukončenie priradenia sa potvrdilo, ale prehľad sa nepodarilo obnoviť. Obnovte stránku."
          : "Priradenie do skupiny bolo ukončené; jeho história zostáva zachovaná.",
      );
    } else {
      setGroupError(true);
      setGroupMessage(
        result.status === "AUTH_REQUIRED"
          ? "Platnosť prihlásenia vypršala. Prihláste sa a skúste to znova."
          : "Výsledok odobratia sa nepodarilo overiť. Zopakujte akciu s rovnakým dôvodom alebo obnovte stránku.",
      );
    }
    groupInFlight.current = false;
    setGroupPending(false);
    return result.status === "REMOVED";
  };
  return (
    <section aria-labelledby="job-roster">
      <h2 id="job-roster">Ľudia na zákazke</h2>
      <p>Potvrdená účasť a zmeny zostávajú v histórii zákazky.</p>
      {page === null && !failed && (
        <p role="status">Načítavajú sa účastníci…</p>
      )}
      {roleMessage && (
        <p role={roleError ? "alert" : "status"}>{roleMessage}</p>
      )}
      {groupMessage && (
        <p role={groupError ? "alert" : "status"}>{groupMessage}</p>
      )}
      {page?.role === "PRIMARY_PROVIDER" &&
        writable &&
        groupPage === null &&
        !groupLoadFailed && (
          <p role="status">Načítavajú sa pracovné skupiny…</p>
        )}
      {groupLoadFailed && (
        <p role="alert">
          Prehľad pracovných skupín sa nepodarilo bezpečne načítať.
        </p>
      )}
      {page && (
        <JobRosterGroups
          page={page}
          jobState={jobState}
          onRoleAction={(participantId, role, action) =>
            void changeRole(participantId, role, action)
          }
          rolesDisabled={rolePending || groupPending || pending}
          {...(groupPage === null ? {} : { workGroups: groupPage.groups })}
          onGroupCreate={createGroup}
          onGroupAssign={assignGroup}
          onGroupRemove={removeGroup}
          removalLocks={removalLocks}
          groupsDisabled={
            rolePending || groupPending || pending || groupsLoadingMore
          }
        />
      )}
      {groupPage?.nextCursor && (
        <button
          disabled={groupPending || rolePending || pending || groupsLoadingMore}
          onClick={() => void moreGroups()}
          type="button"
        >
          Načítať ďalšie skupiny
        </button>
      )}
      {page?.nextCursor && (
        <button
          disabled={pending || failed || rolePending || groupPending}
          onClick={() => void more()}
          type="button"
        >
          Načítať ďalších
        </button>
      )}
      {failed && <p role="alert">Účastníkov sa nepodarilo bezpečne načítať.</p>}
    </section>
  );
}
