"use client";

import { useCallback, useEffect, useState } from "react";

export function NotificationBadge() {
  const [count, setCount] = useState<number | null>(null);
  const reload = useCallback(async () => {
    try {
      const response = await fetch("/v1/me/notifications/unread-count", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const body: unknown = await response.json();
      setCount(
        response.ok &&
          record(body) &&
          Number.isSafeInteger(body.unreadCount) &&
          Number(body.unreadCount) >= 0
          ? Number(body.unreadCount)
          : null,
      );
    } catch {
      setCount(null);
    }
  }, []);
  useEffect(() => {
    const handleChange = () => void reload();
    void reload();
    window.addEventListener("notifications-changed", handleChange);
    return () =>
      window.removeEventListener("notifications-changed", handleChange);
  }, [reload]);
  if (count === null) return null;
  return (
    <a
      aria-label={
        count === 0 ? "Upozornenia" : `Upozornenia, neprečítané: ${count}`
      }
      className="notification-badge"
      href="/ucet/upozornenia"
    >
      Upozornenia
      {count > 0 ? <strong>{count > 99 ? "99+" : count}</strong> : null}
    </a>
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
