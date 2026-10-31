import { describe, expect, test } from "bun:test";
import {
  cancelEvent,
  checkDiscount,
  createDiscount,
  createEvent,
  EventError,
  getEvent,
  listEvents,
  type Actor,
  type EventsContext,
  type OrderRecord,
  type OrdersPort,
} from "../src/domain/events.js";
import { createStore } from "../src/store.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const org: Actor = { id: "org1", role: "organizer" };
const org2: Actor = { id: "org2", role: "organizer" };
const cust: Actor = { id: "c1", role: "customer" };
const tier = { name: "GA", priceCents: 1000, quantity: 10 };
const body = {
  title: "Show",
  venue: "Hall",
  startsAt: "2026-11-02T18:00:00Z",
  tiers: [tier],
};

class FakeOrders implements OrdersPort {
  orders: OrderRecord[] = [];
  waitlistCleared: string[] = [];
  forEvent(eventId: string): OrderRecord[] {
    return this.orders.filter((o) => o.eventId === eventId);
  }
  setStatus(orderId: string, status: OrderRecord["status"]): void {
    const o = this.orders.find((x) => x.id === orderId);
    if (o) o.status = status;
  }
  clearWaitlist(eventId: string): void {
    this.waitlistCleared.push(eventId);
  }
}

function setup(): { ctx: EventsContext; orders: FakeOrders } {
  const orders = new FakeOrders();
  return { ctx: { store: createStore(), orders, now: () => NOW }, orders };
}

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof EventError ? e.kind : "other";
  }
  return undefined;
}

function seed(ctx: EventsContext): void {
  createEvent(ctx, org, { ...body, title: "Beta", startsAt: "2026-11-02T18:00:00Z" });
  createEvent(ctx, org, { ...body, title: "Alpha", startsAt: "2026-11-02T18:00:00Z" });
  createEvent(ctx, org, {
    ...body,
    title: "Early",
    venue: "Arena",
    startsAt: "2026-10-10T00:00:00Z",
  });
  createEvent(ctx, org, { ...body, title: "Late", startsAt: "2026-12-01T00:00:00Z" });
}

function withEvent(): { ctx: EventsContext; orders: FakeOrders; id: string } {
  const s = setup();
  return { ...s, id: createEvent(s.ctx, org, body).id };
}

describe("createEvent", () => {
  test("creates an event with normalized startsAt and full availability", () => {
    const { ctx } = setup();
    const e = createEvent(ctx, org, body);
    expect(e.startsAt).toBe("2026-11-02T18:00:00.000Z");
    expect(e.status).toBe("on_sale");
    expect(e.organizerId).toBe("org1");
    expect(e.tiers[0]).toMatchObject({ name: "GA", priceCents: 1000, quantity: 10, available: 10 });
    expect(getEvent(ctx, e.id)).toEqual(e);
  });

  test("only organizers may create", () => {
    const { ctx } = setup();
    expect(kindOf(() => createEvent(ctx, cust, body))).toBe("forbidden");
    expect(kindOf(() => createEvent(ctx, undefined, body))).toBe("forbidden");
  });

  test.each([
    ["not an object", null],
    ["empty title", { ...body, title: "" }],
    ["long title", { ...body, title: "x".repeat(101) }],
    ["empty venue", { ...body, venue: "" }],
    ["long venue", { ...body, venue: "x".repeat(101) }],
    ["bad date", { ...body, startsAt: "nope" }],
    ["past date", { ...body, startsAt: "2026-09-01T00:00:00Z" }],
    ["no tiers", { ...body, tiers: [] }],
    ["six tiers", { ...body, tiers: [1, 2, 3, 4, 5, 6].map((n) => ({ ...tier, name: `T${n}` })) }],
    ["duplicate tier names", { ...body, tiers: [tier, tier] }],
    ["negative price", { ...body, tiers: [{ ...tier, priceCents: -1 }] }],
    ["fractional price", { ...body, tiers: [{ ...tier, priceCents: 1.5 }] }],
    ["zero quantity", { ...body, tiers: [{ ...tier, quantity: 0 }] }],
    ["huge quantity", { ...body, tiers: [{ ...tier, quantity: 10001 }] }],
    ["tier not object", { ...body, tiers: ["x"] }],
  ])("rejects %s", (_n, input) => {
    const { ctx } = setup();
    expect(kindOf(() => createEvent(ctx, org, input))).toBe("validation");
  });

  test("accepts boundaries: free tier, 5 tiers, 100-char text, quantity 10000", () => {
    const { ctx } = setup();
    const tiers = [1, 2, 3, 4, 5].map((n) => ({ name: `T${n}`, priceCents: 0, quantity: 10000 }));
    const e = createEvent(ctx, org, {
      ...body,
      title: "x".repeat(100),
      venue: "y".repeat(100),
      tiers,
    });
    expect(e.tiers).toHaveLength(5);
  });

  test("available subtracts held and paid orders only", () => {
    const { ctx, orders } = setup();
    const e = createEvent(ctx, org, body);
    const tierId = e.tiers[0]?.id ?? "";
    const mk = (id: string, status: OrderRecord["status"], quantity: number): OrderRecord => ({
      id,
      eventId: e.id,
      status,
      items: [{ tierId, quantity }],
    });
    orders.orders.push(
      mk("a", "held", 2),
      mk("b", "paid", 3),
      mk("c", "expired", 4),
      mk("d", "refunded", 1),
    );
    expect(getEvent(ctx, e.id).tiers[0]?.available).toBe(5);
  });
});

describe("getEvent", () => {
  test("unknown id is not_found", () => {
    expect(kindOf(() => getEvent(setup().ctx, "x"))).toBe("not_found");
  });
});

describe("cancelEvent", () => {
  test("refunds paid, cancels held, clears waitlist and shows cancelled", () => {
    const { ctx, orders } = setup();
    const e = createEvent(ctx, org, body);
    const mk = (id: string, status: OrderRecord["status"]): OrderRecord => ({
      id,
      eventId: e.id,
      status,
      items: [],
    });
    orders.orders.push(mk("p", "paid"), mk("h", "held"), mk("x", "expired"));
    const out = cancelEvent(ctx, org, e.id);
    expect(out.status).toBe("cancelled");
    expect(orders.orders.map((o) => o.status)).toEqual(["refunded", "cancelled", "expired"]);
    expect(orders.waitlistCleared).toEqual([e.id]);
    expect(getEvent(ctx, e.id).status).toBe("cancelled");
  });

  test("other organizer gets forbidden, customer forbidden, unknown 404", () => {
    const { ctx } = setup();
    const e = createEvent(ctx, org, body);
    expect(kindOf(() => cancelEvent(ctx, org2, e.id))).toBe("forbidden");
    expect(kindOf(() => cancelEvent(ctx, cust, e.id))).toBe("forbidden");
    expect(kindOf(() => cancelEvent(ctx, org, "nope"))).toBe("not_found");
  });

  test("cancelling twice is a conflict", () => {
    const { ctx } = setup();
    const e = createEvent(ctx, org, body);
    cancelEvent(ctx, org, e.id);
    expect(kindOf(() => cancelEvent(ctx, org, e.id))).toBe("conflict");
  });
});

describe("listEvents", () => {
  test("sorts by startsAt then title", () => {
    const { ctx } = setup();
    seed(ctx);
    expect(listEvents(ctx).items.map((e) => e.title)).toEqual(["Early", "Alpha", "Beta", "Late"]);
  });

  test("excludes cancelled events", () => {
    const { ctx } = setup();
    seed(ctx);
    const early = listEvents(ctx).items[0];
    cancelEvent(ctx, org, early?.id ?? "");
    const list = listEvents(ctx);
    expect(list.total).toBe(3);
    expect(list.items.map((e) => e.title)).not.toContain("Early");
  });

  test("from and to are inclusive", () => {
    const { ctx } = setup();
    seed(ctx);
    const r = listEvents(ctx, { from: "2026-10-10T00:00:00Z", to: "2026-11-02T18:00:00Z" });
    expect(r.items.map((e) => e.title)).toEqual(["Early", "Alpha", "Beta"]);
    expect(listEvents(ctx, { from: "2026-10-10T00:00:00.001Z" }).total).toBe(3);
    expect(listEvents(ctx, { to: "2026-10-09T23:59:59.999Z" }).total).toBe(0);
  });

  test("q matches title or venue case-insensitively", () => {
    const { ctx } = setup();
    seed(ctx);
    expect(listEvents(ctx, { q: "ALPH" }).items.map((e) => e.title)).toEqual(["Alpha"]);
    expect(listEvents(ctx, { q: "arena" }).items.map((e) => e.title)).toEqual(["Early"]);
  });

  test("paginates and total counts all matches", () => {
    const { ctx } = setup();
    seed(ctx);
    const r = listEvents(ctx, { page: "2", pageSize: "3" });
    expect(r).toMatchObject({ total: 4, page: 2, pageSize: 3 });
    expect(r.items.map((e) => e.title)).toEqual(["Late"]);
    expect(listEvents(ctx).pageSize).toBe(10);
    expect(listEvents(ctx).page).toBe(1);
  });

  test.each([
    ["bad from", { from: "x" }],
    ["bad to", { to: "x" }],
    ["page 0", { page: "0" }],
    ["page text", { page: "a" }],
    ["page fraction", { page: "1.5" }],
    ["pageSize 0", { pageSize: "0" }],
    ["pageSize 51", { pageSize: "51" }],
    ["array value", { q: ["a", "b"] }],
  ])("rejects %s", (_n, query) => {
    const { ctx } = setup();
    expect(kindOf(() => listEvents(ctx, query))).toBe("validation");
  });

  test("pageSize 50 is accepted", () => {
    const { ctx } = setup();
    expect(listEvents(ctx, { pageSize: "50" }).pageSize).toBe(50);
  });
});

describe("discount codes", () => {
  test("stores code upper case and matches case-insensitively", () => {
    const { ctx, id } = withEvent();
    const d = createDiscount(ctx, org, id, { code: "Spring25", percentOff: 25 });
    expect(d).toEqual({ code: "SPRING25", percentOff: 25, uses: 0 });
    expect(checkDiscount(ctx, id, "sPrInG25").code).toBe("SPRING25");
  });

  test("only the event's organizer may create", () => {
    const { ctx, id } = withEvent();
    const input = { code: "ABC", percentOff: 5 };
    expect(kindOf(() => createDiscount(ctx, org2, id, input))).toBe("forbidden");
    expect(kindOf(() => createDiscount(ctx, cust, id, input))).toBe("forbidden");
    expect(kindOf(() => createDiscount(ctx, org, "nope", input))).toBe("not_found");
  });

  test.each([
    ["short code", { code: "ab", percentOff: 5 }],
    ["long code", { code: "A".repeat(21), percentOff: 5 }],
    ["symbols", { code: "AB-C", percentOff: 5 }],
    ["neither", { code: "ABC" }],
    ["both", { code: "ABC", percentOff: 5, amountOffCents: 5 }],
    ["percent 0", { code: "ABC", percentOff: 0 }],
    ["percent 101", { code: "ABC", percentOff: 101 }],
    ["percent fraction", { code: "ABC", percentOff: 1.5 }],
    ["amount 0", { code: "ABC", amountOffCents: 0 }],
    ["maxUses 0", { code: "ABC", percentOff: 5, maxUses: 0 }],
    ["bad expiresAt", { code: "ABC", percentOff: 5, expiresAt: "x" }],
    ["not object", 7],
  ])("rejects %s", (_n, input) => {
    const { ctx, id } = withEvent();
    expect(kindOf(() => createDiscount(ctx, org, id, input))).toBe("validation");
  });

  test("accepts boundaries", () => {
    const { ctx, id } = withEvent();
    expect(createDiscount(ctx, org, id, { code: "ABC", percentOff: 100 }).percentOff).toBe(100);
    expect(
      createDiscount(ctx, org, id, { code: "B".repeat(20), amountOffCents: 1, maxUses: 1 }),
    ).toMatchObject({
      amountOffCents: 1,
      maxUses: 1,
    });
  });

  test("duplicate code on the event is a conflict, even in another case", () => {
    const { ctx, id } = withEvent();
    createDiscount(ctx, org, id, { code: "ABC", percentOff: 5 });
    expect(kindOf(() => createDiscount(ctx, org, id, { code: "abc", percentOff: 9 }))).toBe(
      "conflict",
    );
    const other = createEvent(ctx, org, body).id;
    expect(createDiscount(ctx, org, other, { code: "ABC", percentOff: 5 }).code).toBe("ABC");
  });

  test("unknown code or event is unprocessable / not found", () => {
    const { ctx, id } = withEvent();
    expect(kindOf(() => checkDiscount(ctx, id, "NOPE"))).toBe("unprocessable");
    expect(kindOf(() => checkDiscount(ctx, "nope", "ABC"))).toBe("not_found");
  });

  test("code of another event is unprocessable", () => {
    const { ctx, id } = withEvent();
    const other = createEvent(ctx, org, body).id;
    createDiscount(ctx, org, other, { code: "ONLYTHERE", percentOff: 5 });
    expect(kindOf(() => checkDiscount(ctx, id, "ONLYTHERE"))).toBe("unprocessable");
  });

  test("expired code is unprocessable at and after expiry", () => {
    const { ctx, id } = withEvent();
    createDiscount(ctx, org, id, { code: "OLD", percentOff: 5, expiresAt: "2026-10-01T00:00:00Z" });
    expect(kindOf(() => checkDiscount(ctx, id, "OLD"))).toBe("unprocessable");
    createDiscount(ctx, org, id, { code: "NEW", percentOff: 5, expiresAt: "2026-10-01T00:00:01Z" });
    expect(checkDiscount(ctx, id, "NEW").code).toBe("NEW");
  });

  test("uses count held and paid orders; expired and cancelled give the use back", () => {
    const { ctx, orders, id } = withEvent();
    createDiscount(ctx, org, id, { code: "TWO", percentOff: 5, maxUses: 2 });
    const mk = (oid: string, status: OrderRecord["status"], code = "two"): OrderRecord => ({
      id: oid,
      eventId: id,
      status,
      discountCode: code,
      items: [],
    });
    orders.orders.push(
      mk("1", "held"),
      mk("2", "expired"),
      mk("3", "cancelled"),
      mk("4", "refunded"),
    );
    expect(checkDiscount(ctx, id, "TWO").uses).toBe(1);
    orders.orders.push(mk("5", "paid"), { ...mk("6", "paid", "OTHER") });
    expect(kindOf(() => checkDiscount(ctx, id, "TWO"))).toBe("unprocessable");
    orders.setStatus("5", "expired");
    expect(checkDiscount(ctx, id, "TWO").uses).toBe(1);
  });
});
