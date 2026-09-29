import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActionLink,
  Button,
  FormField,
  Input,
  TrustBadge,
} from "./design-system";

describe("shared design-system primitives", () => {
  it("keeps link and button semantics explicit", () => {
    const markup = renderToStaticMarkup(
      <>
        <ActionLink href="/dopyt">Začať dopyt</ActionLink>
        <Button type="submit">Uložiť</Button>
      </>,
    );

    expect(markup).toContain('<a class="ui-button ui-button--primary"');
    expect(markup).toContain('href="/dopyt"');
    expect(markup).toContain('<button class="ui-button ui-button--primary"');
    expect(markup).toContain('type="submit"');
  });

  it("communicates trust provenance in text and not only with color", () => {
    const markup = renderToStaticMarkup(
      <>
        <TrustBadge provenance="verified">Totožnosť</TrustBadge>
        <TrustBadge provenance="evidence">Odbornosť</TrustBadge>
        <TrustBadge provenance="declared">Prax</TrustBadge>
      </>,
    );

    expect(markup).toContain("Overené platformou:");
    expect(markup).toContain("Podložené dokladom:");
    expect(markup).toContain("Uvedené remeselníkom:");
    expect(markup).toContain("Totožnosť");
    expect(markup).toContain("Odbornosť");
    expect(markup).toContain("Prax");
  });

  it("renders a labelled field with help and error text", () => {
    const markup = renderToStaticMarkup(
      <FormField
        description="Použite adresu, ku ktorej máte prístup."
        error="E-mail nie je platný."
        label="E-mail"
      >
        <Input name="email" type="email" />
      </FormField>,
    );

    expect(markup).toContain("E-mail");
    expect(markup).toContain('name="email"');
    expect(markup).toContain("Použite adresu");
    expect(markup).toContain("E-mail nie je platný");
  });
});
