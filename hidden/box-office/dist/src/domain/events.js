import { createId } from "../store.js";
export class EventError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = "EventError";
        this.kind = kind;
    }
}
export const noOrders = {
    forEvent: () => [],
    setStatus: () => undefined,
    clearWaitlist: () => undefined,
};
const states = new WeakMap();
function eventsOf(store) {
    let map = states.get(store);
    if (map === undefined) {
        map = new Map();
        states.set(store, map);
    }
    return map;
}
function ordersOf(ctx) {
    return ctx.orders ?? noOrders;
}
function nowOf(ctx) {
    return (ctx.now ?? Date.now)();
}
function bad(message) {
    throw new EventError("validation", message);
}
function asObject(input, what) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        bad(`${what} must be an object`);
    }
    return input;
}
function textField(value, field) {
    if (typeof value !== "string" || value.length < 1 || value.length > 100) {
        bad(`${field} must be 1-100 characters`);
    }
    return value;
}
function intField(value, field, min, max = Infinity) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        bad(`${field} must be an integer${max === Infinity ? ` >= ${min}` : ` ${min}-${max}`}`);
    }
    return value;
}
function parseDate(value, field) {
    const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(ms))
        bad(`${field} must be a date`);
    return new Date(ms).toISOString();
}
function validateTiers(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 5) {
        bad("tiers must contain 1-5 entries");
    }
    const names = new Set();
    return input.map((raw) => {
        const t = asObject(raw, "tier");
        const name = textField(t["name"], "tier name");
        if (names.has(name))
            bad("tier names must be unique");
        names.add(name);
        return {
            id: createId(),
            name,
            priceCents: intField(t["priceCents"], "priceCents", 0),
            quantity: intField(t["quantity"], "quantity", 1, 10000),
        };
    });
}
function view(ctx, e) {
    const taken = new Map();
    for (const order of ordersOf(ctx).forEvent(e.id)) {
        if (order.status !== "held" && order.status !== "paid")
            continue;
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
function requireOrganizer(actor) {
    if (actor === undefined || actor.role !== "organizer") {
        throw new EventError("forbidden", "organizer only");
    }
    return actor;
}
function find(ctx, id) {
    const e = eventsOf(ctx.store).get(id);
    if (e === undefined)
        throw new EventError("not_found", "event not found");
    return e;
}
function ownedEvent(ctx, actor, id) {
    const organizer = requireOrganizer(actor);
    const e = find(ctx, id);
    if (e.organizerId !== organizer.id)
        throw new EventError("forbidden", "not your event");
    return e;
}
export function createEvent(ctx, actor, input) {
    const organizer = requireOrganizer(actor);
    const body = asObject(input, "body");
    const title = textField(body["title"], "title");
    const venue = textField(body["venue"], "venue");
    const startsAt = parseDate(body["startsAt"], "startsAt");
    if (Date.parse(startsAt) <= nowOf(ctx))
        bad("startsAt must be in the future");
    const tiers = validateTiers(body["tiers"]);
    const event = {
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
export function getEvent(ctx, id) {
    return view(ctx, find(ctx, id));
}
export function cancelEvent(ctx, actor, id) {
    const e = ownedEvent(ctx, actor, id);
    if (e.status === "cancelled")
        throw new EventError("conflict", "event already cancelled");
    const orders = ordersOf(ctx);
    for (const order of orders.forEvent(e.id)) {
        if (order.status === "paid")
            orders.setStatus(order.id, "refunded");
        else if (order.status === "held")
            orders.setStatus(order.id, "cancelled");
    }
    orders.clearWaitlist(e.id);
    e.status = "cancelled";
    return view(ctx, e);
}
function queryString(query, key) {
    const v = query[key];
    if (v === undefined)
        return undefined;
    if (typeof v !== "string")
        bad(`${key} is invalid`);
    return v;
}
function queryDate(query, key) {
    const v = queryString(query, key);
    if (v === undefined)
        return undefined;
    const ms = Date.parse(v);
    if (Number.isNaN(ms))
        bad(`${key} must be a date`);
    return ms;
}
function queryInt(query, key, fallback, max = Infinity) {
    const v = queryString(query, key);
    if (v === undefined)
        return fallback;
    if (!/^\d+$/.test(v))
        bad(`${key} must be a positive integer`);
    return intField(Number(v), key, 1, max);
}
export function listEvents(ctx, query = {}) {
    const from = queryDate(query, "from");
    const to = queryDate(query, "to");
    const q = queryString(query, "q")?.toLowerCase();
    const page = queryInt(query, "page", 1);
    const pageSize = queryInt(query, "pageSize", 10, 50);
    const matches = Array.from(eventsOf(ctx.store).values())
        .filter((e) => e.status === "on_sale")
        .filter((e) => {
        const ms = Date.parse(e.startsAt);
        if (from !== undefined && ms < from)
            return false;
        if (to !== undefined && ms > to)
            return false;
        return (q === undefined || e.title.toLowerCase().includes(q) || e.venue.toLowerCase().includes(q));
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
function normalizeCode(code) {
    return code.toUpperCase();
}
function usesOf(ctx, eventId, code) {
    return ordersOf(ctx)
        .forEvent(eventId)
        .filter((o) => (o.status === "held" || o.status === "paid") &&
        o.discountCode !== undefined &&
        normalizeCode(o.discountCode) === code).length;
}
function discountView(ctx, eventId, d) {
    return { ...d, uses: usesOf(ctx, eventId, d.code) };
}
export function createDiscount(ctx, actor, eventId, input) {
    const e = ownedEvent(ctx, actor, eventId);
    const body = asObject(input, "body");
    const rawCode = body["code"];
    if (typeof rawCode !== "string" || !/^[A-Za-z0-9]{3,20}$/.test(rawCode)) {
        bad("code must be 3-20 letters or digits");
    }
    const hasPercent = body["percentOff"] !== undefined;
    const hasAmount = body["amountOffCents"] !== undefined;
    if (hasPercent === hasAmount)
        bad("exactly one of percentOff or amountOffCents is required");
    const discount = { code: normalizeCode(rawCode) };
    if (hasPercent)
        discount.percentOff = intField(body["percentOff"], "percentOff", 1, 100);
    if (hasAmount)
        discount.amountOffCents = intField(body["amountOffCents"], "amountOffCents", 1);
    if (body["maxUses"] !== undefined)
        discount.maxUses = intField(body["maxUses"], "maxUses", 1);
    if (body["expiresAt"] !== undefined)
        discount.expiresAt = parseDate(body["expiresAt"], "expiresAt");
    if (e.discounts.has(discount.code))
        throw new EventError("conflict", "code already exists");
    e.discounts.set(discount.code, discount);
    return discountView(ctx, e.id, discount);
}
/** Returns the code when it can be applied now; 422-class otherwise. */
export function checkDiscount(ctx, eventId, code) {
    const e = find(ctx, eventId);
    const d = e.discounts.get(normalizeCode(code));
    if (d === undefined)
        throw new EventError("unprocessable", "code not valid for this event");
    const current = discountView(ctx, e.id, d);
    if (d.expiresAt !== undefined && Date.parse(d.expiresAt) <= nowOf(ctx)) {
        throw new EventError("unprocessable", "code expired");
    }
    if (d.maxUses !== undefined && current.uses >= d.maxUses) {
        throw new EventError("unprocessable", "code used up");
    }
    return current;
}
