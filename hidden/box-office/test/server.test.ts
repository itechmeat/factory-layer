import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const app = createApp({ holdSeconds: 2 });
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  app.server.close();
});

interface Res {
  status: number;
  body: any;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

let counter = 0;
async function user(role: "organizer" | "customer"): Promise<string> {
  counter += 1;
  const email = `${role}${counter}@example.com`;
  const made = await call("POST", "/users", undefined, {
    email,
    password: "password1",
    name: "Test",
    role,
  });
  expect(made.status).toBe(201);
  const session = await call("POST", "/sessions", undefined, { email, password: "password1" });
  expect(session.status).toBe(200);
  return session.body.token;
}

const days = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function event(token: string, over: Record<string, unknown> = {}, quantity = 10) {
  const res = await call("POST", "/events", token, {
    title: "Show",
    venue: "Hall",
    startsAt: days(10),
    tiers: [{ name: "GA", priceCents: 1000, quantity }],
    ...over,
  });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, tier: res.body.tiers[0].id as string };
}

const order = (token: string, eventId: string, tierId: string, quantity: number, extra = {}) =>
  call("POST", "/orders", token, { eventId, items: [{ tierId, quantity }], ...extra });

describe("users and sessions", () => {
  test("register, login, me", async () => {
    const res = await call("POST", "/users", undefined, {
      email: "me@example.com",
      password: "password1",
      name: "Me",
      role: "customer",
    });
    expect(res.status).toBe(201);
    expect(res.body.password).toBeUndefined();
    const dup = await call("POST", "/users", undefined, {
      email: "ME@example.com",
      password: "password1",
      name: "Me",
      role: "customer",
    });
    expect(dup.status).toBe(409);
    const session = await call("POST", "/sessions", undefined, {
      email: "me@example.com",
      password: "password1",
    });
    const me = await call("GET", "/me", session.body.token);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("me@example.com");
  });

  test("invalid input and bad credentials", async () => {
    expect((await call("POST", "/users", undefined, { email: "x" })).status).toBe(400);
    const wrong = await call("POST", "/sessions", undefined, {
      email: "me@example.com",
      password: "nope",
    });
    expect(wrong.status).toBe(401);
    expect(typeof wrong.body.error).toBe("string");
  });
});

describe("conventions", () => {
  test("invalid JSON is 400, unknown route 404, errors carry a message", async () => {
    const bad = await call("POST", "/users", undefined, "{nope");
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe("string");
    const missing = await call("GET", "/nothing");
    expect(missing.status).toBe(404);
    expect(typeof missing.body.error).toBe("string");
    expect((await call("DELETE", "/events")).status).toBe(404);
  });

  test("token is checked before role, role before input", async () => {
    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("GET", "/me", "bogus")).status).toBe(401);
    expect((await call("POST", "/events", undefined, "{nope")).status).toBe(401);
    const customer = await user("customer");
    expect((await call("POST", "/events", customer, "{nope")).status).toBe(403);
    const organizer = await user("organizer");
    expect((await call("POST", "/events", organizer, "{nope")).status).toBe(400);
    expect((await call("POST", "/orders", organizer, {})).status).toBe(403);
    expect((await call("POST", "/orders", customer, {})).status).toBe(400);
    expect((await call("GET", "/me/orders", organizer)).status).toBe(403);
    expect((await call("GET", "/me/waitlist")).status).toBe(401);
  });

  test("named things are 404 and others' things 403", async () => {
    const organizer = await user("organizer");
    const other = await user("organizer");
    const customer = await user("customer");
    const missing = "00000000-0000-0000-0000-000000000000";
    expect((await call("GET", `/events/${missing}`)).status).toBe(404);
    expect((await call("POST", `/events/${missing}/cancel`, organizer)).status).toBe(404);
    expect((await call("POST", `/orders/${missing}/pay`, customer)).status).toBe(404);
    expect((await call("GET", `/orders/${missing}`, customer)).status).toBe(404);
    const e = await event(organizer);
    expect((await call("POST", `/events/${e.id}/cancel`, other)).status).toBe(403);
    expect((await call("GET", `/events/${e.id}/report`, other)).status).toBe(403);
    const d = { code: "ABC", percentOff: 10 };
    expect((await call("POST", `/events/${e.id}/discounts`, other, d)).status).toBe(403);
  });
});

describe("events", () => {
  test("create, get, list with filters and pagination", async () => {
    const organizer = await user("organizer");
    const tag = `Zed${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await event(organizer, { title: `${tag} ${i}`, startsAt: days(20 + i), venue: "Arena" });
    }
    const e = await event(organizer, {
      title: `${tag} special`,
      venue: "Quay",
      startsAt: days(40),
    });
    const one = await call("GET", `/events/${e.id}`);
    expect(one.status).toBe(200);
    expect(one.body.tiers[0].available).toBe(10);
    expect(one.body.startsAt).toBe(new Date(one.body.startsAt).toISOString());

    const all = await call("GET", `/events?q=${tag}`);
    expect(all.body.total).toBe(4);
    const paged = await call("GET", `/events?q=${tag}&page=2&pageSize=3`);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.page).toBe(2);
    const byVenue = await call("GET", `/events?q=quay`);
    expect(byVenue.body.items.map((x: any) => x.id)).toEqual([e.id]);
    const from = await call("GET", `/events?q=${tag}&from=${encodeURIComponent(days(30))}`);
    expect(from.body.total).toBe(1);
    const to = await call("GET", `/events?q=${tag}&to=${encodeURIComponent(days(30))}`);
    expect(to.body.total).toBe(3);
    expect((await call("GET", "/events?page=0")).status).toBe(400);
    expect((await call("GET", "/events?pageSize=51")).status).toBe(400);
  });

  test("validation of new events", async () => {
    const organizer = await user("organizer");
    const res = await call("POST", "/events", organizer, { title: "", venue: "x" });
    expect(res.status).toBe(400);
    const past = await call("POST", "/events", organizer, {
      title: "Old",
      venue: "x",
      startsAt: days(-1),
      tiers: [{ name: "GA", priceCents: 1, quantity: 1 }],
    });
    expect(past.status).toBe(400);
  });

  test("cancel removes the event from listings and refunds orders", async () => {
    const organizer = await user("organizer");
    const customer = await user("customer");
    const e = await event(organizer, { title: `Cx${Date.now()}` });
    const o = await order(customer, e.id, e.tier, 2);
    await call("POST", `/orders/${o.body.id}/pay`, customer);
    const res = await call("POST", `/events/${e.id}/cancel`, organizer);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await call("GET", `/orders/${o.body.id}`, customer)).body.status).toBe("refunded");
    expect((await call("POST", `/events/${e.id}/cancel`, organizer)).status).toBe(409);
    expect((await order(customer, e.id, e.tier, 1)).status).toBe(409);
  });
});

describe("orders", () => {
  test("hold then pay, listed under /me/orders", async () => {
    const organizer = await user("organizer");
    const customer = await user("customer");
    const e = await event(organizer);
    const held = await order(customer, e.id, e.tier, 2);
    expect(held.status).toBe(201);
    expect(held.body.status).toBe("held");
    expect(held.body.totalCents).toBe(2000);
    expect(held.body.expiresAt).toBe(new Date(held.body.expiresAt).toISOString());
    expect((await call("GET", `/events/${e.id}`)).body.tiers[0].available).toBe(8);
    const paid = await call("POST", `/orders/${held.body.id}/pay`, customer);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("paid");
    expect((await call("POST", `/orders/${held.body.id}/pay`, customer)).status).toBe(409);
    const mine = await call("GET", "/me/orders", customer);
    expect(mine.body.map((o: any) => o.id)).toEqual([held.body.id]);
    const seen = await call("GET", `/orders/${held.body.id}`, organizer);
    expect(seen.status).toBe(200);
    const stranger = await user("customer");
    expect((await call("GET", `/orders/${held.body.id}`, stranger)).status).toBe(404);
  });

  test("holds expire and free the tickets", async () => {
    const organizer = await user("organizer");
    const customer = await user("customer");
    const e = await event(organizer, {}, 3);
    const held = await order(customer, e.id, e.tier, 3);
    expect((await order(await user("customer"), e.id, e.tier, 1)).status).toBe(409);
    await sleep(2300);
    expect((await call("GET", `/events/${e.id}`)).body.tiers[0].available).toBe(3);
    expect((await call("GET", `/orders/${held.body.id}`, customer)).body.status).toBe("expired");
    expect((await call("POST", `/orders/${held.body.id}/pay`, customer)).status).toBe(409);
  });

  test("six tickets per event is the limit", async () => {
    const organizer = await user("organizer");
    const customer = await user("customer");
    const e = await event(organizer);
    expect((await order(customer, e.id, e.tier, 6)).status).toBe(201);
    const more = await order(customer, e.id, e.tier, 1);
    expect(more.status).toBe(422);
    expect(typeof more.body.error).toBe("string");
  });

  test("item validation and unknown tiers are 400", async () => {
    const organizer = await user("organizer");
    const customer = await user("customer");
    const e = await event(organizer);
    expect((await order(customer, e.id, e.tier, 0)).status).toBe(400);
    expect((await order(customer, e.id, "nope", 1)).status).toBe(400);
    expect((await order(customer, "missing", e.tier, 1)).status).toBe(404);
  });

  test("cancel a held order, and refund rules around 24 hours", async () => {
    const organizer = await user("organizer");
    const customer = await user("customer");
    const e = await event(organizer);
    const held = await order(customer, e.id, e.tier, 1);
    const cancelled = await call("POST", `/orders/${held.body.id}/cancel`, customer);
    expect(cancelled.body.status).toBe("cancelled");
    expect((await call("POST", `/orders/${held.body.id}/cancel`, customer)).status).toBe(409);

    const paid = await order(customer, e.id, e.tier, 1);
    await call("POST", `/orders/${paid.body.id}/pay`, customer);
    const refunded = await call("POST", `/orders/${paid.body.id}/cancel`, customer);
    expect(refunded.status).toBe(200);
    expect(refunded.body.status).toBe("refunded");

    const soon = await event(organizer, {
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const late = await order(customer, soon.id, soon.tier, 1);
    await call("POST", `/orders/${late.body.id}/pay`, customer);
    expect((await call("POST", `/orders/${late.body.id}/cancel`, customer)).status).toBe(409);
  });
});

describe("discounts", () => {
  test("percentage and amount math, uses, and limits", async () => {
    const organizer = await user("organizer");
    const e = await event(organizer);
    const pct = await call("POST", `/events/${e.id}/discounts`, organizer, {
      code: "ten",
      percentOff: 10,
      maxUses: 1,
    });
    expect(pct.status).toBe(201);
    expect(pct.body.code).toBe("TEN");
    expect(pct.body.uses).toBe(0);
    const dup = await call("POST", `/events/${e.id}/discounts`, organizer, {
      code: "TEN",
      percentOff: 5,
    });
    expect(dup.status).toBe(409);
    const both = await call("POST", `/events/${e.id}/discounts`, organizer, {
      code: "BOTH",
      percentOff: 5,
      amountOffCents: 5,
    });
    expect(both.status).toBe(400);
    await call("POST", `/events/${e.id}/discounts`, organizer, {
      code: "FIVE",
      amountOffCents: 500,
    });
    await call("POST", `/events/${e.id}/discounts`, organizer, {
      code: "OLD",
      percentOff: 50,
      expiresAt: new Date(Date.now() + 500).toISOString(),
    });

    const a = await user("customer");
    const first = await order(a, e.id, e.tier, 3, { discountCode: "ten" });
    expect(first.body.subtotalCents).toBe(3000);
    expect(first.body.discountCents).toBe(300);
    expect(first.body.totalCents).toBe(2700);
    const b = await user("customer");
    expect((await order(b, e.id, e.tier, 1, { discountCode: "TEN" })).status).toBe(422);
    const amount = await order(b, e.id, e.tier, 2, { discountCode: "FIVE" });
    expect(amount.body.totalCents).toBe(1500);
    expect((await order(b, e.id, e.tier, 1, { discountCode: "NOPE" })).status).toBe(422);
    await sleep(700);
    expect((await order(b, e.id, e.tier, 1, { discountCode: "OLD" })).status).toBe(422);
  });
});

describe("waitlist", () => {
  test("join, positions, and strict order after expiry", async () => {
    const organizer = await user("organizer");
    const e = await event(organizer, {}, 2);
    const holder = await user("customer");
    await order(holder, e.id, e.tier, 2);
    const first = await user("customer");
    const second = await user("customer");
    const joinedFirst = await call("POST", `/events/${e.id}/waitlist`, first, {
      tierId: e.tier,
      quantity: 2,
    });
    expect(joinedFirst.status).toBe(201);
    expect(joinedFirst.body.position).toBe(1);
    const joinedSecond = await call("POST", `/events/${e.id}/waitlist`, second, {
      tierId: e.tier,
      quantity: 1,
    });
    expect(joinedSecond.body.position).toBe(2);
    expect(
      (await call("POST", `/events/${e.id}/waitlist`, second, { tierId: e.tier, quantity: 1 }))
        .status,
    ).toBe(409);
    expect(
      (await call("POST", `/events/${e.id}/waitlist`, second, { tierId: e.tier, quantity: 0 }))
        .status,
    ).toBe(400);
    const listed = await call("GET", "/me/waitlist", second);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].position).toBe(2);

    await sleep(2300);
    const served = await call("GET", "/me/orders", first);
    expect(served.body).toHaveLength(1);
    expect(served.body[0].status).toBe("held");
    expect(served.body[0].items[0].quantity).toBe(2);
    expect((await call("GET", "/me/orders", second)).body).toHaveLength(0);
    expect((await call("GET", "/me/waitlist", first)).body).toHaveLength(0);
  });

  test("joining while tickets are available is a conflict", async () => {
    const organizer = await user("organizer");
    const customer = await user("customer");
    const e = await event(organizer);
    const res = await call("POST", `/events/${e.id}/waitlist`, customer, {
      tierId: e.tier,
      quantity: 1,
    });
    expect(res.status).toBe(409);
  });
});

describe("report", () => {
  test("sales figures for the organizer", async () => {
    const organizer = await user("organizer");
    const e = await event(organizer);
    await call("POST", `/events/${e.id}/discounts`, organizer, { code: "HALF", percentOff: 50 });
    const a = await user("customer");
    const b = await user("customer");
    const paid = await order(a, e.id, e.tier, 2, { discountCode: "HALF" });
    await call("POST", `/orders/${paid.body.id}/pay`, a);
    const gone = await order(b, e.id, e.tier, 1);
    await call("POST", `/orders/${gone.body.id}/pay`, b);
    await call("POST", `/orders/${gone.body.id}/cancel`, b);
    await order(b, e.id, e.tier, 3);
    const report = await call("GET", `/events/${e.id}/report`, organizer);
    expect(report.status).toBe(200);
    expect(report.body.tiers[0]).toMatchObject({ sold: 2, held: 3, available: 5 });
    expect(report.body.grossCents).toBe(2000);
    expect(report.body.discountCents).toBe(1000);
    expect(report.body.netCents).toBe(1000);
    expect(report.body.refundedCents).toBe(1000);
  });
});

describe("config", () => {
  test("reads PORT and HOLD_SECONDS", () => {
    expect(loadConfig({})).toEqual({ port: 3000, holdSeconds: 600 });
    expect(loadConfig({ PORT: "0", HOLD_SECONDS: "2" })).toEqual({ port: 0, holdSeconds: 2 });
    expect(loadConfig({ HOLD_SECONDS: "abc" }).holdSeconds).toBe(600);
    expect(() => loadConfig({ PORT: "70000" })).toThrow();
    expect(() => loadConfig({ PORT: "abc" })).toThrow();
  });
});
