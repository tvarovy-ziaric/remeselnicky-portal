export const ALPHA_GATE_SESSION_COOKIE = "__Host-remeselnicky_alpha_gate";

export async function ensureAlphaGateSession({
  baseURL,
  context,
  password,
  returnTo = "/",
}) {
  const target = new URL(returnTo, baseURL);
  if (target.origin !== new URL(baseURL).origin) {
    throw new Error("Alpha gate return target must stay on the app origin");
  }

  const page = await context.newPage();
  try {
    await page.goto(
      new URL(
        `/_alpha-gate/login?return=${encodeURIComponent(`${target.pathname}${target.search}`)}`,
        baseURL,
      ).href,
    );
    if (!new URL(page.url()).pathname.startsWith("/_alpha-gate/login")) {
      return;
    }
    await page.getByLabel("Používateľ").fill("alpha");
    await page.getByLabel("Heslo").fill(password);
    await page
      .getByRole("button", { name: "Vstúpiť do testovacej verzie" })
      .click();
    await page.waitForURL((url) => url.pathname === target.pathname);
    const cookie = (await context.cookies(baseURL)).find(
      (candidate) => candidate.name === ALPHA_GATE_SESSION_COOKIE,
    );
    if (cookie === undefined) {
      throw new Error("Alpha gate did not issue its session cookie");
    }
  } finally {
    await page.close();
  }
}
