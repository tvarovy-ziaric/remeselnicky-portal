"use client";

import React, {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createCustomerShortlistStore,
  type CustomerShortlistStore,
} from "./customer-shortlist-store";

const ShortlistContext = createContext<CustomerShortlistStore | null>(null);

export function CustomerShortlistProvider({
  children,
  store: suppliedStore,
}: {
  readonly children: ReactNode;
  readonly store?: CustomerShortlistStore;
}) {
  const [store] = useState(
    () => suppliedStore ?? createCustomerShortlistStore(),
  );
  useEffect(() => {
    const controller = new AbortController();
    void store.load(controller.signal);
    return () => controller.abort();
  }, [store]);
  return (
    <ShortlistContext.Provider value={store}>
      {children}
    </ShortlistContext.Provider>
  );
}

export function CustomerShortlistToggle({
  craftsmanProfileId,
}: {
  readonly craftsmanProfileId: string;
}) {
  const sharedStore = useContext(ShortlistContext);
  if (sharedStore === null) {
    return (
      <CustomerShortlistProvider>
        <ContextBackedToggle craftsmanProfileId={craftsmanProfileId} />
      </CustomerShortlistProvider>
    );
  }
  return (
    <ContextBackedToggle
      craftsmanProfileId={craftsmanProfileId}
      store={sharedStore}
    />
  );
}

function ContextBackedToggle({
  craftsmanProfileId,
  store: explicitStore,
}: {
  readonly craftsmanProfileId: string;
  readonly store?: CustomerShortlistStore;
}) {
  const contextStore = useContext(ShortlistContext);
  const store = explicitStore ?? contextStore;
  if (store === null) throw new Error("Shortlist provider is required.");
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
  if (snapshot.status === "AUTH_REQUIRED") {
    return (
      <p className="shortlist-auth-note">Na uloženie výberu sa prihláste.</p>
    );
  }
  if (snapshot.status === "UNAVAILABLE") {
    return <p aria-live="polite">Výber sa teraz nepodarilo načítať.</p>;
  }
  const ready = snapshot.status === "READY";
  const saved = ready && snapshot.savedProfileIds.has(craftsmanProfileId);
  const pending = ready && snapshot.pendingProfileIds.has(craftsmanProfileId);
  return (
    <button
      aria-pressed={saved}
      disabled={!ready || pending}
      onClick={() => void store.toggle(craftsmanProfileId)}
      type="button"
    >
      {!ready
        ? "Načítavam výber…"
        : pending
          ? "Ukladám…"
          : saved
            ? "Odobrať z výberu"
            : "Pridať do výberu"}
    </button>
  );
}
