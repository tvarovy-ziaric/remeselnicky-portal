import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const root = new URL("../../../", import.meta.url);
const stateUrl = new URL(".alpha/r3-e2e-fixture.json", root);
const environment = await readFile(new URL(".env.alpha", root), "utf8");
const hostname = /^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)$/mu.exec(
  environment,
)?.[1];
if (!hostname)
  throw new Error("Only the isolated Quick Tunnel staging origin is supported");
const baseURL = `https://${hostname}`;
const basicPassword = (
  await readFile(new URL(".alpha/secrets/quick_gate_password", root), "utf8")
).trim();
const accountPassword = (
  await readFile(
    new URL(".alpha/secrets/synthetic_seed_password", root),
    "utf8",
  )
).trim();
let state;
let originChanged = false;
try {
  state = JSON.parse(await readFile(stateUrl, "utf8"));
  originChanged = state.baseURL !== baseURL;
  if (
    originChanged &&
    !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u.test(state.baseURL)
  )
    throw new Error(
      "Fixture origin is not a Quick Tunnel; inspect old state before reprovisioning",
    );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  state = { baseURL };
}

const browser = await chromium.launch({ headless: true });
const actors = [];
try {
  const customer = await login(101);
  const customerB = await login(104);
  const providerA = await login(102);
  const providerB = await login(103);
  actors.push(customer, customerB, providerA, providerB);
  if (originChanged) {
    if (state.requestA)
      await get(customer, `/v1/me/job-requests/${state.requestA}`);
    if (state.requestB)
      await get(customerB, `/v1/me/job-requests/${state.requestB}`);
    state.baseURL = baseURL;
    await save();
  }
  const candidates = await get(
    customer,
    "/v1/public/craftsmen/search?professionCode=PROF%3AALPHA_SYNTHETIC",
  );
  const profileIds = [
    "Testovací remeselník Alfa",
    "Syntetická dielňa Beta",
  ].map((name) => {
    const matches = candidates.items?.filter(
      (item) => item.identity?.primaryName === name,
    );
    if (matches?.length !== 1 || typeof matches[0].profileId !== "string") {
      throw new Error(`Expected exactly one synthetic public profile: ${name}`);
    }
    return matches[0].profileId;
  });

  state.requestA ??= await createRequest(customer, "A");
  await save();
  state.requestB ??= await createRequest(customerB, "B");
  await save();
  for (const [letter, profileId, provider] of [
    ["A", profileIds[0], providerA],
    ["B", profileIds[1], providerB],
  ]) {
    const invitationKey = `invitation${letter}`;
    const conversationKey = `conversation${letter}`;
    const mediaKey = `media${letter}`;
    const quoteKey = `quote${letter}`;
    const canaryKey = `canary${letter}`;
    if (!state[invitationKey]) {
      const result = await post(
        customer,
        `/v1/me/job-requests/${state.requestA}/invitations`,
        {
          commandId: randomUUID(),
          craftsmanProfileId: profileId,
        },
        201,
      );
      state[invitationKey] = result.id;
      await save();
    }
    const invitation = await get(
      provider,
      `/v1/me/invitations/${state[invitationKey]}`,
    );
    if (invitation.state === "PENDING") {
      await post(
        provider,
        `/v1/me/invitations/${state[invitationKey]}/respond`,
        {
          action: "ENGAGE",
          commandId: randomUUID(),
          expectedRevision: invitation.revision,
        },
        200,
      );
    }
    if (!state[conversationKey]) {
      const result = await get(
        provider,
        `/v1/me/invitations/${state[invitationKey]}/conversation`,
      );
      state[conversationKey] = result.id;
      await save();
    }
    state[canaryKey] ??=
      `Synthetic provider ${letter} alpha ${alphabeticNonce()}`;
    if (!state[mediaKey]) {
      const message = await post(
        provider,
        `/v1/me/conversations/${state[conversationKey]}/messages`,
        {
          body: state[canaryKey],
          commandId: randomUUID(),
        },
        201,
      );
      const response = await provider.context.request.post(
        `/v1/me/conversations/${state[conversationKey]}/messages/${message.entry.id}/attachments/documents`,
        {
          data: Buffer.from(minimalPdf(letter)),
          headers: {
            "content-type": "application/pdf",
            "x-csrf-token": provider.csrf,
          },
        },
      );
      const upload = await checked(response, 202);
      state[mediaKey] = upload.assetId;
      await save();
    }
    await waitReady(provider, state[conversationKey], state[mediaKey]);
    if (!state[quoteKey]) {
      const current = await get(
        provider,
        `/v1/me/invitations/${state[invitationKey]}`,
      );
      const created = await post(
        provider,
        `/v1/me/conversations/${state[conversationKey]}/quotes`,
        {
          authoringMode: "PLATFORM_STRUCTURED",
          commandId: randomUUID(),
          requestContentRevision: current.requestContentRevision,
          requestVisibleVersion: current.requestVisibleVersion,
        },
        201,
      );
      state[quoteKey] = created.quote.id;
      await save();
    }
    const quote = await get(provider, `/v1/me/quotes/${state[quoteKey]}`);
    if (!quote.currentSubmitted) {
      const structured = await provider.context.request.get(
        `/v1/me/quotes/${state[quoteKey]}/revisions/1/structured`,
      );
      if (structured.status() === 404) {
        await post(
          provider,
          `/v1/me/quotes/${state[quoteKey]}/revisions/1/structured`,
          {
            commandId: randomUUID(),
            expectedContentRevision: 0,
            content: {
              components: {},
              conditionalOnInspection: false,
              currency: "EUR",
              materialResponsibility: "PROVIDER",
              priceBasis: "Cena za syntetické práce.",
              priceMode: "FIXED",
              summary: state[canaryKey],
              title: `Syntetická ponuka ${letter}`,
              totalAmountCents: letter === "A" ? 125000 : 175000,
              vatStatus: "VAT_INCLUDED",
            },
          },
          200,
        );
      }
      await post(
        provider,
        `/v1/me/quotes/${state[quoteKey]}/revisions/1/submit`,
        {
          commandId: randomUUID(),
          expectedDraftStateRevision: quote.currentDraft.stateRevision,
          expectedSubmittedStateRevision: null,
        },
        200,
      );
    }
  }
  process.stdout.write(
    "R3 synthetic fixture provisioned via HTTPS; IDs saved in ignored .alpha/r3-e2e-fixture.json.\n",
  );
} finally {
  await Promise.all(actors.map((actor) => actor.context.close()));
  await browser.close();
}

async function save() {
  await writeFile(stateUrl, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}
async function login(number) {
  const authStateUrl = new URL(`.alpha/r3-e2e-auth-${number}.json`, root);
  let storedState;
  try {
    storedState = JSON.parse(await readFile(authStateUrl, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const context = await browser.newContext({
    baseURL,
    httpCredentials: {
      origin: baseURL,
      username: "alpha",
      password: basicPassword,
    },
    ...(storedState === undefined ? {} : { storageState: storedState }),
  });
  const session = await context.request.get("/v1/auth/session");
  if (session.status() === 200) {
    const body = await session.json();
    return { context, csrf: body.csrfToken };
  }
  if (session.status() !== 401)
    throw new Error(`Unexpected synthetic session HTTP ${session.status()}`);
  const csrfResponse = await context.request.get("/v1/auth/csrf");
  const csrf = (await checked(csrfResponse, 200)).csrfToken;
  await checked(
    await context.request.post("/v1/auth/login", {
      data: {
        email: `synthetic.account.${number}@portal.invalid`,
        password: accountPassword,
      },
      headers: { "x-csrf-token": csrf },
    }),
    200,
  );
  const authenticatedCsrf = (
    await checked(await context.request.get("/v1/auth/csrf"), 200)
  ).csrfToken;
  await context.storageState({ path: fileURLToPath(authStateUrl) });
  return { context, csrf: authenticatedCsrf };
}
async function get(actor, path) {
  return checked(await actor.context.request.get(path), 200);
}
async function post(actor, path, data, expected) {
  return checked(
    await actor.context.request.post(path, {
      data,
      headers: { "x-csrf-token": actor.csrf },
    }),
    expected,
  );
}
async function checked(response, expected) {
  if (response.status() !== expected) {
    const body = await response.text();
    throw new Error(
      `Fixture HTTP ${response.status()} (expected ${expected}): ${body.slice(0, 300)}`,
    );
  }
  return response.json();
}
async function createRequest(actor, letter) {
  const created = await post(
    actor,
    "/v1/me/job-request-drafts",
    {
      commandId: randomUUID(),
      section: {
        key: "request.core",
        schemaVersion: 1,
        payload: {
          description: `Syntetický testovací dopyt ${letter}.`,
          primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
          relatedProfessionCodes: [],
          skillCodes: [],
          specializationCode: null,
          title: `Syntetický dopyt ${letter}`,
        },
      },
    },
    201,
  );
  const saved = await post(
    actor,
    `/v1/me/job-request-drafts/${created.id}/sections`,
    {
      commandId: randomUUID(),
      expectedRevision: created.revision,
      section: {
        key: "request.location",
        schemaVersion: 1,
        payload: {
          exactAddress: null,
          mapPin: null,
          municipalityCode: "TEST:MUNICIPALITY_ALPHA",
          textClarification: null,
        },
      },
    },
    200,
  );
  await post(
    actor,
    `/v1/me/job-request-drafts/${created.id}/activate`,
    {
      commandId: randomUUID(),
      expectedRevision: saved.revision,
    },
    200,
  );
  return created.id;
}
async function waitReady(actor, conversationId, assetId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const timeline = await get(
      actor,
      `/v1/me/conversations/${conversationId}/timeline?limit=50`,
    );
    const attachment = timeline.entries
      ?.flatMap((entry) => entry.attachments ?? [])
      .find((item) => item.assetId === assetId);
    if (attachment?.status === "READY") return;
    if (attachment?.status === "REJECTED")
      throw new Error("Synthetic clean PDF was rejected");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Synthetic PDF processing did not reach READY");
}
function minimalPdf(letter) {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let pdf = `%PDF-1.7\n% synthetic alpha ${letter}\n`;
  const offsets = [];
  for (const object of objects) {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += object;
  }
  const xrefOffset = encoder.encode(pdf).byteLength;
  pdf += "xref\n0 5\n0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function alphabeticNonce() {
  return randomUUID()
    .replaceAll("-", "")
    .replace(/[0-9a-f]/gu, (digit) =>
      String.fromCharCode(97 + Number.parseInt(digit, 16)),
    );
}
