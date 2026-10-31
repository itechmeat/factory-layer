import { createId, type Role, type Store } from "../store.js";

export type EventErrorKind =
  | "validation"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable";

export class EventError extends Error {
  readonly kind: EventErrorKind;
  constructor(kind: EventErrorKind, message: string) {
    super(message);
    this.name = "EventError";
    this.kind = kind;
  }
}

export type EventStatus = "on_sale" | "cancelled";
export type OrderStatus = "held" | "paid" | "expired" | "cancelled" | "refunded";

export interface Actor {
  id: string;
  role: Role;
}

export interface Tier {
  id: string;
  name: string;
  priceCents: number;
  quantity: number;
  available: number;
}

export interface EventRecord {
  id: string;
  title: string;
  venue: string;
  startsAt: string;
  status: EventStatus;
  organizerId: string;
  tiers: Tier[];
}

export interface OrderRecord {
  id: string;
  eventId: string;
  status: OrderStatus;
  discountCode?: string | undefined;
  items: { tierId: string; quantity: number }[];
}

/** What the events domain needs from the orders domain. */
export interface OrdersPort {
  forEvent(eventId: string): OrderRecord[];
  setStatus(orderId: string, status: OrderStatus): void;
  clearWaitlist(eventId: string): void;
}

export const noOrders: OrdersPort = {
  forEvent: () => [],
  setStatus: () => undefined,
  clearWaitlist: () => undefined,
};

export interface DiscountCode {
  code: string;
  percentOff?: number;
  amountOffCents?: number;
  maxUses?: number;
  expiresAt?: string;
  uses: number;
}

interface StoredEvent extends Omit<EventRecord, "tiers"> {
  tiers: Omit<Tier, "available">[];
  discounts: Map<string, Omit<DiscountCode, "uses">>;
}

const states = new WeakMap<Store, Map<string, StoredEvent>>();

function eventsOf(store: Store): Map<string, StoredEvent> {
  let map = states.get(store);
  if (map === undefined) {
    map = new Map();
    states.set(store, map);
  }
  return map;
}

export interface EventsContext {
  store: Store;
  orders?: OrdersPort;
  now?: () => number;
}

function ordersOf(ctx: EventsContext): OrdersPort {
  return ctx.orders ?? noOrders;
}

function nowOf(ctx: EventsContext): number {
  return (ctx.now ?? Date.now)();
}

function bad(message: string): never {
  throw new EventError("validation", message);
}

function asObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    bad(`${what} must be an object`);
  }
  return input as Record<string, unknown>;
}

function textField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    bad(`${field} must be 1-100 characters`);
  }
  return value;
}

function intField(value: unknown, field: string, min: number, max = Infinity): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    bad(`${field} must be an integer${max === Infinity ? ` >= ${min}` : ` ${min}-${max}`}`);
  }
  return value;
}

function parseDate(value: unknown, field: string): string {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) bad(`${field} must be a date`);
  return new Date(ms).toISOString();
}

function validateTiers(input: unknown): Omit<Tier, "available">[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) {
    bad("tiers must contain 1-5 entries");
  }
  const names = new Set<string>();
  return input.map((raw: unknown) => {
    const t = asObject(raw, "tier");
    const name = textField(t["name"], "tier name");
    if (names.has(name)) bad("tier names must be unique");
    names.add(name);
    return {
      id: createId(),
      name,
      priceCents: intField(t["priceCents"], "priceCents", 0),
      quantity: intField(t["quantity"], "quantity", 1, 10000),
    };
  });
}

function view(ctx: EventsContext, e: StoredEvent): EventRecord {
  const taken = new Map<string, number>();
  for (const order of ordersOf(ctx).forEvent(e.id)) {
    if (order.status !== "held" && order.status !== "paid") continue;
    for (const item of order.items) {
      taken.set(item.tierId, (taken.get(item.tierId) ?? 0) + item.quantity);
    }
  }
  return {
    id: e.id,
    title: e.title,
    venue: e.venue,
    startsAt: e.startsAt,
    status: e.status,
    organizerId: e.organizerId,
    tiers: e.tiers.map((t) => ({ ...t, available: t.quantity - (taken.get(t.id) ?? 0) })),
  };
}

function requireOrganizer(actor: Actor | undefined): Actor {
  if (actor === undefined || actor.role !== "organizer") {
    throw new EventError("forbidden", "organizer only");
  }
  return actor;
}

function find(ctx: EventsContext, id: string): StoredEvent {
  const e = eventsOf(ctx.store).get(id);
  if (e === undefined) throw new EventError("not_found", "event not found");
  return e;
}

function ownedEvent(ctx: EventsContext, actor: Actor | undefined, id: string): StoredEvent {
  const organizer = requireOrganizer(actor);
  const e = find(ctx, id);
  if (e.organizerId !== organizer.id) throw new EventError("forbidden", "not your event");
  return e;
}

export function createEvent(
  ctx: EventsContext,
  actor: Actor | undefined,
  input: unknown,
): EventRecord {
  const organizer = requireOrganizer(actor);
  const body = asObject(input, "body");
  const title = textField(body["title"], "title");
  const venue = textField(body["venue"], "venue");
  const startsAt = parseDate(body["startsAt"], "startsAt");
  if (Date.parse(startsAt) <= nowOf(ctx)) bad("startsAt must be in the future");
  const tiers = validateTiers(body["tiers"]);
  const event: StoredEvent = {
    id: createId(),
    title,
    venue,
    startsAt,
    status: "on_sale",
    organizerId: organizer.id,
    tiers,
    discounts: new Map(),
  };
  eventsOf(ctx.store).set(event.id, event);
  return view(ctx, event);
}

export function getEvent(ctx: EventsContext, id: string): EventRecord {
  return view(ctx, find(ctx, id));
}

export function cancelEvent(ctx: EventsContext, actor: Actor | undefined, id: string): EventRecord {
  const e = ownedEvent(ctx, actor, id);
  if (e.status === "cancelled") throw new EventError("conflict", "event already cancelled");
  const orders = ordersOf(ctx);
  for (const order of orders.forEvent(e.id)) {
    if (order.status === "paid") orders.setStatus(order.id, "refunded");
    else if (order.status === "held") orders.setStatus(order.id, "cancelled");
  }
  orders.clearWaitlist(e.id);
  e.status = "cancelled";
  return view(ctx, e);
}

export interface ListResult {
  items: EventRecord[];
  total: number;
  page: number;
  pageSize: number;
}

function queryString(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") bad(`${key} is invalid`);
  return v;
}

function queryDate(query: Record<string, unknown>, key: string): number | undefined {
  const v = queryString(query, key);
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) bad(`${key} must be a date`);
  return ms;
}

function queryInt(
  query: Record<string, unknown>,
  key: string,
  fallback: number,
  max = Infinity,
): number {
  const v = queryString(query, key);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v)) bad(`${key} must be a positive integer`);
  return intField(Number(v), key, 1, max);
}

export function listEvents(ctx: EventsContext, query: Record<string, unknown> = {}): ListResult {
  const from = queryDate(query, "from");
  const to = queryDate(query, "to");
  const q = queryString(query, "q")?.toLowerCase();
  const page = queryInt(query, "page", 1);
  const pageSize = queryInt(query, "pageSize", 10, 50);
  const matches = Array.from(eventsOf(ctx.store).values())
    .filter((e) => e.status === "on_sale")
    .filter((e) => {
      const ms = Date.parse(e.startsAt);
      if (from !== undefined && ms < from) return false;
      if (to !== undefined && ms > to) return false;
      return (
        q === undefined || e.title.toLowerCase().includes(q) || e.venue.toLowerCase().includes(q)
      );
    })
    .toSorted((a, b) => {
      const byTime = Date.parse(a.startsAt) - Date.parse(b.startsAt);
      return byTime !== 0 ? byTime : a.title.localeCompare(b.title);
    });
  const start = (page - 1) * pageSize;
  return {
    items: matches.slice(start, start + pageSize).map((e) => view(ctx, e)),
    total: matches.length,
    page,
    pageSize,
  };
}

function normalizeCode(code: string): string {
  return code.toUpperCase();
}

function usesOf(ctx: EventsContext, eventId: string, code: string): number {
  return ordersOf(ctx)
    .forEvent(eventId)
    .filter(
      (o) =>
        (o.status === "held" || o.status === "paid") &&
        o.discountCode !== undefined &&
        normalizeCode(o.discountCode) === code,
    ).length;
}

function discountView(
  ctx: EventsContext,
  eventId: string,
  d: Omit<DiscountCode, "uses">,
): DiscountCode {
  return { ...d, uses: usesOf(ctx, eventId, d.code) };
}

export function createDiscount(
  ctx: EventsContext,
  actor: Actor | undefined,
  eventId: string,
  input: unknown,
): DiscountCode {
  const e = ownedEvent(ctx, actor, eventId);
  const body = asObject(input, "body");
  const rawCode = body["code"];
  if (typeof rawCode !== "string" || !/^[A-Za-z0-9]{3,20}$/.test(rawCode)) {
    bad("code must be 3-20 letters or digits");
  }
  const hasPercent = body["percentOff"] !== undefined;
  const hasAmount = body["amountOffCents"] !== undefined;
  if (hasPercent === hasAmount) bad("exactly one of percentOff or amountOffCents is required");
  const discount: Omit<DiscountCode, "uses"> = { code: normalizeCode(rawCode) };
  if (hasPercent) discount.percentOff = intField(body["percentOff"], "percentOff", 1, 100);
  if (hasAmount) discount.amountOffCents = intField(body["amountOffCents"], "amountOffCents", 1);
  if (body["maxUses"] !== undefined) discount.maxUses = intField(body["maxUses"], "maxUses", 1);
  if (body["expiresAt"] !== undefined)
    discount.expiresAt = parseDate(body["expiresAt"], "expiresAt");
  if (e.discounts.has(discount.code)) throw new EventError("conflict", "code already exists");
  e.discounts.set(discount.code, discount);
  return discountView(ctx, e.id, discount);
}

/** Returns the code when it can be applied now; 422-class otherwise. */
export function checkDiscount(ctx: EventsContext, eventId: string, code: string): DiscountCode {
  const e = find(ctx, eventId);
  const d = e.discounts.get(normalizeCode(code));
  if (d === undefined) throw new EventError("unprocessable", "code not valid for this event");
  const current = discountView(ctx, e.id, d);
  if (d.expiresAt !== undefined && Date.parse(d.expiresAt) <= nowOf(ctx)) {
    throw new EventError("unprocessable", "code expired");
  }
  if (d.maxUses !== undefined && current.uses >= d.maxUses) {
    throw new EventError("unprocessable", "code used up");
  }
  return current;
}
