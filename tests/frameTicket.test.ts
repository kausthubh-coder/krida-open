import { describe, expect, test } from "vitest";
import { openTicket, signTicket } from "../server/frameTicket";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const KEY = "1b2c3d4e-account-torbox-key";

describe("frame tickets", () => {
  test("a ticket opens to the account's TorBox key for the file it names, for a day", async () => {
    const t = await signTicket("secret", 34_304_564_141, KEY, NOW);
    expect(t.expires).toBe(NOW + DAY);
    expect(await openTicket("secret", 34_304_564_141, t.expires, t.ticket, NOW + 60_000)).toBe(KEY);
  });

  test("whoever holds the ticket can't read the key in it", async () => {
    const t = await signTicket("secret", 7, KEY, NOW);
    const bytes = Uint8Array.from(atob(t.ticket.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(new TextDecoder("latin1").decode(bytes).includes(KEY)).toBe(false);
    expect(t.ticket.includes(KEY)).toBe(false);
    // Sealed afresh each time: two tickets for the same file and key differ.
    expect((await signTicket("secret", 7, KEY, NOW)).ticket === t.ticket).toBe(false);
  });

  test("a fresh ticket opens where the checker's clock is a little behind the signer's", async () => {
    const t = await signTicket("secret", 7, KEY, NOW);
    expect(await openTicket("secret", 7, t.expires, t.ticket, NOW - 2_000)).toBe(KEY);
  });

  test("refuses another file, another secret, a changed expiry, a changed byte, and a ticket that ran out", async () => {
    const t = await signTicket("secret", 34_304_564_141, KEY, NOW);
    expect(await openTicket("secret", 34_304_564_142, t.expires, t.ticket, NOW)).toBe(null);
    expect(await openTicket("other", 34_304_564_141, t.expires, t.ticket, NOW)).toBe(null);
    expect(await openTicket("secret", 34_304_564_141, t.expires - 1, t.ticket, NOW)).toBe(null);
    expect(await openTicket("secret", 34_304_564_141, t.expires, t.ticket, NOW + DAY + 1)).toBe(null);
    const flipped = t.ticket.slice(0, 20) + (t.ticket[20] === "A" ? "B" : "A") + t.ticket.slice(21);
    expect(await openTicket("secret", 34_304_564_141, t.expires, flipped, NOW)).toBe(null);
  });

  test("refuses an expiry more than a day off, and anything that isn't a ticket", async () => {
    const later = await signTicket("secret", 7, KEY, NOW + DAY);
    // Further off than a day and the 5 minutes allowed for the two clocks.
    expect(await openTicket("secret", 7, later.expires, later.ticket, NOW)).toBe(null);
    const t = await signTicket("secret", 7, KEY, NOW);
    expect(await openTicket("secret", 7, t.expires, `${t.ticket}!`, NOW)).toBe(null);
    expect(await openTicket("secret", 7, t.expires, "", NOW)).toBe(null);
    expect(await openTicket("secret", 7, Number.NaN, t.ticket, NOW)).toBe(null);
  });

  test("without a secret, nothing is sealed or opened", async () => {
    await expect(signTicket("", 7, KEY, NOW)).rejects.toThrow("FRAMES_SECRET isn't set");
  });
});
