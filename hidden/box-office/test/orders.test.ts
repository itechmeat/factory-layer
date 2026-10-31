import { describe, expect, test } from "bun:test";
import {
  cancelEvent,
  createDiscount,
  createEvent,
  type Actor,
  type EventRecord,
  type EventsContext,
} from "../src/domain/events.js";
import {
  configFromEnv,
  createOrders,
  OrderError,
  type OrdersService,
} from "../src/domain/orders.js";
import { createStore } from "../src/store.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const org: Actor = { id: "org1", role: "organizer" };
const org2: Actor = { id: "org2", role: "organizer" };
const ann: Actor = { id: "ann", role: "customer" };
const bob: Actor = { id: "bob", role: "customer" };
const cy: Actor = { id: "cy", role: "customer" };

interface World {
  clock: { now: number };
  ctx: EventsContext;
  svc: OrdersService;
  event: EventRecord;
  ga: string;
  vip: string;
}

function world(opts: { holdSeconds?: number; gaQty?: number; startsAt?: string } = {}): World {
  const clock = { now: T0 };
  const store = createStore();
  const holder: { ctx?: EventsContext } = {};
  const svc = createOrders({
    store,
    config: { holdSeconds: opts.holdSeconds ?? 600 },
    events: () => holder.ctx as EventsContext,
    now: () => clock.now,
  });
  const ctx: EventsContext = { store, orders: svc.port, now: () => clock.now };
  holder.ctx = ctx;
  const event = createEvent(ctx, org, {
    title: "Show",
    venue: "Hall",
    startsAt: opts.startsAt ?? "2026-11-02T18:00:00Z",
    tiers: [
      { name: "GA", priceCents: 1000, quantity: opts.gaQty ?? 10 },
      { name: "VIP", priceCents: 5000, quantity: 3 },
    ],
  });
  return {
    clock,
    ctx,
    svc,
    event,
    ga: event.tiers[0]?.id ?? "",
    vip: event.tiers[1]?.id ?? "",
  };
}

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof OrderError ? e.kind : "other";
  }
  return undefined;
}

function hold(w: World, actor: Actor, quantity: number, extra: Record<string, unknown> = {}) {
  return w.svc.hold(actor, w.event.id, { items: [{ tierId: w.ga, quantity }], ...extra });
}

function availableGa(w: World): number {
  return w.svc.report(org, w.event.id).tiers[0]?.available ?? -1;
}

describe("configFromEnv", () => {
  test("defaults to 600", () => {
    expect(configFromEnv({})).toEqual({ holdSeconds: 600 });
    expect(configFromEnv({ HOLD_SECONDS: "abc" })).toEqual({ holdSeconds: 600 });
    expect(configFromEnv({ HOLD_SECONDS: "0" })).toEqual({ holdSeconds: 600 });
  });
  test("reads HOLD_SECONDS", () => {
    expect(configFromEnv({ HOLD_SECONDS: "30" })).toEqual({ holdSeconds: 30 });
  });
});

describe("hold", () => {
  test("creates a held order with prices and expiry", () => {
    const w = world();
    const o = w.svc.hold(ann, w.event.id, {
      items: [
        { tierId: w.ga, quantity: 2 },
        { tierId: w.vip, quantity: 1 },
      ],
    });
    expect(o).toMatchObject({
      eventId: w.event.id,
      customerId: "ann",
      status: "held",
      subtotalCents: 7000,
      discountCode: null,
      discountCents: 0,
      totalCents: 7000,
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:10:00.000Z",
      paidAt: null,
    });
    expect(o.items).toEqual([
      { tierId: w.ga, quantity: 2, unitPriceCents: 1000 },
      { tierId: w.vip, quantity: 1, unitPriceCents: 5000 },
    ]);
    expect(availableGa(w)).toBe(8);
  });

  test("uses the configured hold seconds", () => {
    const w = world({ holdSeconds: 30 });
    expect(hold(w, ann, 1).expiresAt).toBe("2026-10-01T00:00:30.000Z");
  });

  test("customers only", () => {
    const w = world();
    expect(kindOf(() => hold(w, org, 1))).toBe("forbidden");
    expect(kindOf(() => w.svc.hold(undefined, w.event.id, {}))).toBe("forbidden");
  });

  test.each([
    ["not an object", 5],
    ["no items", { items: [] }],
    ["items not array", { items: "x" }],
    ["item not object", { items: [3] }],
    ["no tierId", { items: [{ quantity: 1 }] }],
    ["zero quantity", { items: [{ tierId: "t", quantity: 0 }] }],
    ["fractional quantity", { items: [{ tierId: "t", quantity: 1.5 }] }],
    ["string quantity", { items: [{ tierId: "t", quantity: "1" }] }],
    ["bad code type", { items: [{ tierId: "t", quantity: 1 }], discountCode: 5 }],
  ])("rejects invalid body: %s", (_n, body) => {
    const w = world();
    expect(kindOf(() => w.svc.hold(ann, w.event.id, body))).toBe("validation");
  });

  test("rejects a tier twice", () => {
    const w = world();
    const items = [
      { tierId: w.ga, quantity: 1 },
      { tierId: w.ga, quantity: 1 },
    ];
    expect(kindOf(() => w.svc.hold(ann, w.event.id, { items }))).toBe("validation");
  });

  test("unknown event is 404, foreign tier is 400", () => {
    const w = world();
    expect(kindOf(() => w.svc.hold(ann, "nope", { items: [{ tierId: w.ga, quantity: 1 }] }))).toBe(
      "not_found",
    );
    expect(
      kindOf(() => w.svc.hold(ann, w.event.id, { items: [{ tierId: "other", quantity: 1 }] })),
    ).toBe("validation");
  });

  test("cancelled or started events are 409", () => {
    const w = world();
    w.clock.now = Date.parse("2026-11-02T18:00:00Z");
    expect(kindOf(() => hold(w, ann, 1))).toBe("conflict");
    const w2 = world();
    cancelEvent(w2.ctx, org, w2.event.id);
    expect(kindOf(() => hold(w2, ann, 1))).toBe("conflict");
  });

  test("insufficient tickets in any tier is 409 and holds nothing", () => {
    const w = world();
    const items = [
      { tierId: w.ga, quantity: 2 },
      { tierId: w.vip, quantity: 4 },
    ];
    expect(kindOf(() => w.svc.hold(ann, w.event.id, { items }))).toBe("conflict");
    expect(availableGa(w)).toBe(10);
    expect(w.svc.mine(ann)).toEqual([]);
  });

  test("at most 6 tickets per event counting held and paid", () => {
    const w = world();
    const first = hold(w, ann, 4);
    expect(kindOf(() => hold(w, ann, 3))).toBe("unprocessable");
    w.svc.pay(ann, first.id);
    expect(kindOf(() => hold(w, ann, 3))).toBe("unprocessable");
    expect(hold(w, ann, 2).status).toBe("held");
    expect(kindOf(() => hold(w, ann, 1))).toBe("unprocessable");
  });

  test("cancelled orders do not count toward the limit", () => {
    const w = world();
    const o = hold(w, ann, 6);
    w.svc.cancel(ann, o.id);
    expect(hold(w, ann, 6).status).toBe("held");
  });

  test("percentage discount floors", () => {
    const w = world();
    createDiscount(w.ctx, org, w.event.id, { code: "TEN", percentOff: 15 });
    const o = w.svc.hold(ann, w.event.id, {
      items: [{ tierId: w.ga, quantity: 3 }],
      discountCode: "ten",
    });
    expect(o).toMatchObject({
      subtotalCents: 3000,
      discountCode: "TEN",
      discountCents: 450,
      totalCents: 2550,
    });
  });

  test("percentage discount rounds down on odd amounts", () => {
    const w = world();
    createDiscount(w.ctx, org, w.event.id, { code: "THIRD", percentOff: 33 });
    const o = hold(w, ann, 1, { discountCode: "THIRD" });
    expect(o.discountCents).toBe(330);
    const w2 = world();
    createDiscount(w2.ctx, org, w2.event.id, { code: "ODD", percentOff: 1 });
    const o2 = w2.svc.hold(ann, w2.event.id, {
      items: [{ tierId: w2.ga, quantity: 1 }],
      discountCode: "ODD",
    });
    expect(o2.discountCents).toBe(10);
  });

  test("amount discount is capped at the subtotal", () => {
    const w = world();
    createDiscount(w.ctx, org, w.event.id, { code: "BIG", amountOffCents: 99999 });
    const o = hold(w, ann, 1, { discountCode: "BIG" });
    expect(o).toMatchObject({ discountCents: 1000, totalCents: 0 });
  });

  test("unusable discount codes are 422", () => {
    const w = world();
    expect(kindOf(() => hold(w, ann, 1, { discountCode: "NOPE" }))).toBe("unprocessable");
    createDiscount(w.ctx, org, w.event.id, { code: "ONCE", percentOff: 10, maxUses: 1 });
    hold(w, ann, 1, { discountCode: "ONCE" });
    expect(kindOf(() => hold(w, bob, 1, { discountCode: "ONCE" }))).toBe("unprocessable");
  });
});

describe("lazy expiry", () => {
  test("a held order past expiresAt is expired and frees its tickets", () => {
    const w = world();
    const o = hold(w, ann, 4);
    expect(availableGa(w)).toBe(6);
    w.clock.now = T0 + 599_000;
    expect(w.svc.get(ann, o.id).status).toBe("held");
    w.clock.now = T0 + 600_000;
    expect(w.svc.get(ann, o.id).status).toBe("expired");
    expect(availableGa(w)).toBe(10);
  });

  test("every read path expires due orders", () => {
    const w = world();
    hold(w, ann, 1);
    w.clock.now = T0 + 700_000;
    expect(w.ctx.orders?.forEvent(w.event.id)[0]?.status).toBe("expired");
    const w2 = world();
    hold(w2, ann, 1);
    w2.clock.now = T0 + 700_000;
    expect(w2.svc.mine(ann)[0]?.status).toBe("expired");
    const w3 = world();
    hold(w3, ann, 1);
    w3.clock.now = T0 + 700_000;
    expect(w3.svc.report(org, w3.event.id).tiers[0]?.held).toBe(0);
  });

  test("expireDue expires explicitly", () => {
    const w = world();
    const o = hold(w, ann, 1);
    w.svc.expireDue(T0 + 600_000);
    expect(o.status).toBe("expired");
  });

  test("paid orders never expire", () => {
    const w = world();
    const o = hold(w, ann, 1);
    w.svc.pay(ann, o.id);
    w.clock.now = T0 + 9_000_000;
    expect(w.svc.get(ann, o.id).status).toBe("paid");
  });
});

describe("pay", () => {
  test("sets paidAt", () => {
    const w = world();
    const o = hold(w, ann, 1);
    w.clock.now = T0 + 5000;
    const paid = w.svc.pay(ann, o.id);
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBe("2026-10-01T00:00:05.000Z");
  });

  test("someone else's order is 404", () => {
    const w = world();
    const o = hold(w, ann, 1);
    expect(kindOf(() => w.svc.pay(bob, o.id))).toBe("not_found");
    expect(kindOf(() => w.svc.pay(ann, "nope"))).toBe("not_found");
  });

  test("not held (including expired) is 409", () => {
    const w = world();
    const o = hold(w, ann, 1);
    w.svc.pay(ann, o.id);
    expect(kindOf(() => w.svc.pay(ann, o.id))).toBe("conflict");
    const late = hold(w, bob, 1);
    w.clock.now = T0 + 600_000;
    expect(kindOf(() => w.svc.pay(bob, late.id))).toBe("conflict");
  });
});

describe("cancel", () => {
  test("held becomes cancelled and frees tickets", () => {
    const w = world();
    const o = hold(w, ann, 3);
    expect(w.svc.cancel(ann, o.id).status).toBe("cancelled");
    expect(availableGa(w)).toBe(10);
  });

  test("paid is refunded more than 24 hours before the event", () => {
    const w = world();
    const o = hold(w, ann, 3);
    w.svc.pay(ann, o.id);
    expect(w.svc.cancel(ann, o.id).status).toBe("refunded");
    expect(availableGa(w)).toBe(10);
  });

  test("paid cannot be refunded within 24 hours", () => {
    const w = world();
    const o = hold(w, ann, 1);
    w.svc.pay(ann, o.id);
    w.clock.now = Date.parse("2026-11-02T18:00:00Z") - 24 * 3600 * 1000;
    expect(kindOf(() => w.svc.cancel(ann, o.id))).toBe("conflict");
    expect(o.status).toBe("paid");
    w.clock.now -= 1000;
    expect(w.svc.cancel(ann, o.id).status).toBe("refunded");
  });

  test("other statuses are 409; others' orders are 404", () => {
    const w = world();
    const o = hold(w, ann, 1);
    expect(kindOf(() => w.svc.cancel(bob, o.id))).toBe("not_found");
    w.svc.cancel(ann, o.id);
    expect(kindOf(() => w.svc.cancel(ann, o.id))).toBe("conflict");
    const e = hold(w, ann, 1);
    w.clock.now = T0 + 600_000;
    expect(kindOf(() => w.svc.cancel(ann, e.id))).toBe("conflict");
  });
});

describe("reading orders", () => {
  test("visible to the customer and the event's organizer only", () => {
    const w = world();
    const o = hold(w, ann, 1);
    expect(w.svc.get(ann, o.id).id).toBe(o.id);
    expect(w.svc.get(org, o.id).id).toBe(o.id);
    expect(kindOf(() => w.svc.get(bob, o.id))).toBe("not_found");
    expect(kindOf(() => w.svc.get(org2, o.id))).toBe("not_found");
    expect(kindOf(() => w.svc.get(undefined, o.id))).toBe("not_found");
    expect(kindOf(() => w.svc.get(ann, "nope"))).toBe("not_found");
  });

  test("my orders are newest first", () => {
    const w = world();
    const a = hold(w, ann, 1);
    const b = hold(w, ann, 1);
    w.clock.now += 1000;
    const c = hold(w, ann, 1);
    hold(w, bob, 1);
    expect(w.svc.mine(ann).map((o) => o.id)).toEqual([c.id, b.id, a.id]);
    expect(kindOf(() => w.svc.mine(org))).toBe("forbidden");
  });
});

function soldOut(): World {
  const w = world({ gaQty: 4 });
  hold(w, ann, 4);
  return w;
}

function join(w: World, actor: Actor, quantity: number) {
  return w.svc.joinWaitlist(actor, w.event.id, { tierId: w.ga, quantity });
}

describe("waitlist", () => {
  test("join gives 1-based positions per tier", () => {
    const w = soldOut();
    expect(join(w, bob, 1).position).toBe(1);
    expect(join(w, cy, 2).position).toBe(2);
    w.svc.hold(cy, w.event.id, { items: [{ tierId: w.vip, quantity: 3 }] });
    const vipFirst = w.svc.joinWaitlist(bob, w.event.id, { tierId: w.vip, quantity: 1 });
    expect(vipFirst.position).toBe(1);
  });

  test("customers only; quantity 1-6", () => {
    const w = soldOut();
    expect(kindOf(() => join(w, org, 1))).toBe("forbidden");
    expect(kindOf(() => join(w, bob, 0))).toBe("validation");
    expect(kindOf(() => join(w, bob, 7))).toBe("validation");
    expect(kindOf(() => join(w, bob, 1.5))).toBe("validation");
    expect(kindOf(() => w.svc.joinWaitlist(bob, w.event.id, 5))).toBe("validation");
    expect(kindOf(() => w.svc.joinWaitlist(bob, w.event.id, { quantity: 1 }))).toBe("validation");
    expect(
      kindOf(() => w.svc.joinWaitlist(bob, w.event.id, { tierId: "other", quantity: 1 })),
    ).toBe("validation");
    expect(kindOf(() => w.svc.joinWaitlist(bob, "nope", { tierId: w.ga, quantity: 1 }))).toBe(
      "not_found",
    );
  });

  test("allowed only when fewer than quantity tickets are available", () => {
    const w = world({ gaQty: 4 });
    expect(kindOf(() => join(w, bob, 1))).toBe("conflict");
    hold(w, ann, 3);
    expect(kindOf(() => join(w, bob, 1))).toBe("conflict");
    expect(join(w, bob, 2).position).toBe(1);
  });

  test("duplicate waiting customer for a tier is 409", () => {
    const w = soldOut();
    join(w, bob, 1);
    expect(kindOf(() => join(w, bob, 2))).toBe("conflict");
  });

  test("my waitlist shows current positions", () => {
    const w = soldOut();
    join(w, bob, 2);
    join(w, cy, 1);
    expect(w.svc.myWaitlist(cy).map((e) => e.position)).toEqual([2]);
    expect(kindOf(() => w.svc.myWaitlist(org))).toBe("forbidden");
  });

  test("expiry frees tickets and serves the queue in order", () => {
    const w = soldOut();
    join(w, bob, 3);
    join(w, cy, 1);
    w.clock.now = T0 + 600_000;
    const bobs = w.svc.mine(bob);
    expect(bobs).toHaveLength(1);
    expect(bobs[0]).toMatchObject({
      status: "held",
      discountCode: null,
      subtotalCents: 3000,
      createdAt: "2026-10-01T00:10:00.000Z",
      expiresAt: "2026-10-01T00:20:00.000Z",
    });
    expect(w.svc.mine(cy)).toHaveLength(1);
    expect(w.svc.myWaitlist(bob)).toEqual([]);
    expect(w.svc.myWaitlist(cy)).toEqual([]);
  });

  test("serving stops at the first entry that no longer fits", () => {
    const w = world({ gaQty: 4 });
    const h1 = hold(w, ann, 3);
    hold(w, cy, 1);
    const dave: Actor = { id: "dave", role: "customer" };
    join(w, bob, 3);
    join(w, dave, 1);
    w.svc.cancel(ann, h1.id);
    expect(w.svc.mine(bob)).toHaveLength(1);
    expect(w.svc.mine(dave)).toHaveLength(0);
    expect(w.svc.myWaitlist(dave)[0]?.position).toBe(1);
  });

  test("strict order: freeing fewer tickets than the head needs serves nobody", () => {
    const w = world({ gaQty: 4 });
    const a = hold(w, ann, 1);
    hold(w, { id: "d1", role: "customer" }, 3);
    join(w, bob, 2);
    join(w, cy, 1);
    w.svc.cancel(ann, a.id);
    expect(w.svc.mine(bob)).toHaveLength(0);
    expect(w.svc.mine(cy)).toHaveLength(0);
    expect(w.svc.myWaitlist(bob)[0]?.position).toBe(1);
    expect(w.svc.myWaitlist(cy)[0]?.position).toBe(2);
  });

  test("refunds also serve the waitlist", () => {
    const w = soldOut();
    const o = w.svc.mine(ann)[0];
    if (o === undefined) throw new Error("missing order");
    w.svc.pay(ann, o.id);
    join(w, bob, 2);
    w.svc.cancel(ann, o.id);
    expect(w.svc.mine(bob)).toHaveLength(1);
  });

  test("over-limit head is removed and the next entry served", () => {
    const w = world({ gaQty: 8 });
    const filler = hold(w, { id: "f", role: "customer" }, 6);
    hold(w, { id: "g", role: "customer" }, 2);
    // bob already owns 3 tickets in the VIP tier
    w.svc.hold(bob, w.event.id, { items: [{ tierId: w.vip, quantity: 3 }] });
    join(w, bob, 4);
    join(w, cy, 2);
    w.svc.cancel({ id: "f", role: "customer" }, filler.id);
    expect(w.svc.mine(bob)).toHaveLength(1);
    expect(w.svc.mine(bob)[0]?.items[0]?.tierId).toBe(w.vip);
    expect(w.svc.myWaitlist(bob)).toEqual([]);
    expect(w.svc.mine(cy)).toHaveLength(1);
  });

  test("cancelling the event clears the waitlist and serves nobody", () => {
    const w = soldOut();
    join(w, bob, 1);
    cancelEvent(w.ctx, org, w.event.id);
    expect(w.svc.myWaitlist(bob)).toEqual([]);
    expect(w.svc.mine(bob)).toEqual([]);
  });
});

describe("report", () => {
  test("organizer only, own event only", () => {
    const w = world();
    expect(kindOf(() => w.svc.report(ann, w.event.id))).toBe("forbidden");
    expect(kindOf(() => w.svc.report(undefined, w.event.id))).toBe("forbidden");
    expect(kindOf(() => w.svc.report(org2, w.event.id))).toBe("forbidden");
    expect(kindOf(() => w.svc.report(org, "nope"))).toBe("not_found");
  });

  test("totals per tier and money", () => {
    const w = world();
    createDiscount(w.ctx, org, w.event.id, { code: "HALF", percentOff: 50 });
    const paid = hold(w, ann, 2, { discountCode: "HALF" });
    w.svc.pay(ann, paid.id);
    const refunded = hold(w, bob, 1);
    w.svc.pay(bob, refunded.id);
    w.svc.cancel(bob, refunded.id);
    hold(w, cy, 3);
    const expired = w.svc.hold(cy, w.event.id, { items: [{ tierId: w.vip, quantity: 1 }] });
    w.svc.cancel(cy, expired.id);
    const r = w.svc.report(org, w.event.id);
    expect(r.tiers[0]).toEqual({ tierId: w.ga, name: "GA", sold: 2, held: 3, available: 5 });
    expect(r.tiers[1]).toEqual({ tierId: w.vip, name: "VIP", sold: 0, held: 0, available: 3 });
    expect(r).toMatchObject({
      grossCents: 2000,
      discountCents: 1000,
      netCents: 1000,
      refundedCents: 1000,
    });
  });
});
