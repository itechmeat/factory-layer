import { createId } from "../store.js";
import { checkDiscount, EventError, getEvent, } from "./events.js";
export class OrderError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = "OrderError";
        this.kind = kind;
    }
}
export const MAX_TICKETS_PER_EVENT = 6;
export const DEFAULT_HOLD_SECONDS = 600;
const REFUND_CUTOFF_MS = 24 * 60 * 60 * 1000;
/** Reads HOLD_SECONDS from an environment; anything but a positive integer falls back to 600. */
export function configFromEnv(env) {
    const raw = env["HOLD_SECONDS"];
    const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    return { holdSeconds: Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_HOLD_SECONDS };
}
function bad(message) {
    throw new OrderError("validation", message);
}
function requireCustomer(actor) {
    if (actor === undefined || actor.role !== "customer") {
        throw new OrderError("forbidden", "customer only");
    }
    return actor;
}
function isInt(value, min, max = Infinity) {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function discountAmount(code, subtotal) {
    if (code.percentOff !== undefined)
        return Math.floor((subtotal * code.percentOff) / 100);
    return Math.min(code.amountOffCents ?? 0, subtotal);
}
function parseItems(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        bad("body must be an object");
    }
    const raw = input["items"];
    if (!Array.isArray(raw) || raw.length < 1)
        bad("items must contain at least one entry");
    const seen = new Set();
    return raw.map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            bad("item must be an object");
        }
        const { tierId, quantity } = entry;
        if (typeof tierId !== "string" || tierId.length < 1)
            bad("tierId is required");
        if (seen.has(tierId))
            bad("a tier may appear only once");
        seen.add(tierId);
        if (!isInt(quantity, 1))
            bad("quantity must be an integer >= 1");
        return { tierId, quantity };
    });
}
function parseDiscountCode(input) {
    const code = input["discountCode"];
    if (code === undefined || code === null)
        return undefined;
    if (typeof code !== "string" || code.length < 1)
        bad("discountCode must be a string");
    return code;
}
export function createOrders(options) {
    const { config } = options;
    const clock = options.now ?? Date.now;
    const orders = [];
    let waiting = [];
    let expiring = false;
    const eventOf = (id) => {
        try {
            return getEvent(options.events(), id);
        }
        catch (e) {
            if (e instanceof EventError && e.kind === "not_found") {
                throw new OrderError("not_found", "event not found");
            }
            throw e;
        }
    };
    const isLive = (o) => o.status === "held" || o.status === "paid";
    const ticketsOf = (customerId, eventId) => orders
        .filter((o) => o.customerId === customerId && o.eventId === eventId && isLive(o))
        .reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.quantity, 0), 0);
    const openForSale = (event) => event.status === "on_sale" && Date.parse(event.startsAt) > clock();
    const newOrder = (customerId, event, items, code) => {
        const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0);
        const discount = code === undefined ? 0 : discountAmount(code, subtotal);
        const createdAt = clock();
        const order = {
            id: createId(),
            eventId: event.id,
            customerId,
            status: "held",
            items,
            subtotalCents: subtotal,
            discountCode: code?.code ?? null,
            discountCents: discount,
            totalCents: subtotal - discount,
            createdAt: new Date(createdAt).toISOString(),
            expiresAt: new Date(createdAt + config.holdSeconds * 1000).toISOString(),
            paidAt: null,
        };
        orders.push(order);
        return order;
    };
    /** Serves each tier's queue strictly in order for as many tickets as are free. */
    const serveWaitlist = (eventId) => {
        if (!waiting.some((w) => w.eventId === eventId))
            return;
        const event = eventOf(eventId);
        if (!openForSale(event))
            return;
        for (const tier of event.tiers) {
            let available = tier.available;
            for (;;) {
                const first = waiting.find((w) => w.eventId === eventId && w.tierId === tier.id);
                if (first === undefined)
                    break;
                if (ticketsOf(first.customerId, eventId) + first.quantity > MAX_TICKETS_PER_EVENT) {
                    waiting = waiting.filter((w) => w !== first);
                    continue;
                }
                if (first.quantity > available)
                    break;
                newOrder(first.customerId, event, [{ tierId: tier.id, quantity: first.quantity, unitPriceCents: tier.priceCents }], undefined);
                available -= first.quantity;
                waiting = waiting.filter((w) => w !== first);
            }
        }
    };
    const expireDue = (now) => {
        if (expiring)
            return;
        expiring = true;
        try {
            const freed = new Set();
            for (const o of orders) {
                if (o.status === "held" && Date.parse(o.expiresAt) <= now) {
                    o.status = "expired";
                    freed.add(o.eventId);
                }
            }
            for (const eventId of freed)
                serveWaitlist(eventId);
        }
        finally {
            expiring = false;
        }
    };
    const sweep = () => expireDue(clock());
    const toRecord = (o) => ({
        id: o.id,
        eventId: o.eventId,
        status: o.status,
        discountCode: o.discountCode ?? undefined,
        items: o.items.map((i) => ({ tierId: i.tierId, quantity: i.quantity })),
    });
    const port = {
        forEvent(eventId) {
            sweep();
            return orders.filter((o) => o.eventId === eventId).map(toRecord);
        },
        setStatus(orderId, status) {
            const order = orders.find((o) => o.id === orderId);
            if (order !== undefined)
                order.status = status;
        },
        clearWaitlist(eventId) {
            waiting = waiting.filter((w) => w.eventId !== eventId);
        },
    };
    const own = (actor, orderId) => {
        const customer = requireCustomer(actor);
        const order = orders.find((o) => o.id === orderId && o.customerId === customer.id);
        if (order === undefined)
            throw new OrderError("not_found", "order not found");
        return order;
    };
    const position = (w) => {
        const queue = waiting.filter((x) => x.eventId === w.eventId && x.tierId === w.tierId);
        return { ...w, position: queue.indexOf(w) + 1 };
    };
    return {
        port,
        expireDue,
        hold(actor, eventId, input) {
            const customer = requireCustomer(actor);
            const wanted = parseItems(input);
            const codeText = parseDiscountCode(input);
            sweep();
            const event = eventOf(eventId);
            const items = wanted.map((w) => {
                const tier = event.tiers.find((t) => t.id === w.tierId);
                if (tier === undefined)
                    bad("tier does not belong to this event");
                return { tier, quantity: w.quantity };
            });
            if (!openForSale(event))
                throw new OrderError("conflict", "event is not on sale");
            if (items.some((i) => i.quantity > i.tier.available)) {
                throw new OrderError("conflict", "not enough tickets available");
            }
            const total = items.reduce((sum, i) => sum + i.quantity, 0);
            if (ticketsOf(customer.id, event.id) + total > MAX_TICKETS_PER_EVENT) {
                throw new OrderError("unprocessable", "at most 6 tickets per event");
            }
            let code;
            if (codeText !== undefined) {
                try {
                    code = checkDiscount(options.events(), event.id, codeText);
                }
                catch (e) {
                    if (e instanceof EventError)
                        throw new OrderError("unprocessable", e.message);
                    throw e;
                }
            }
            return newOrder(customer.id, event, items.map((i) => ({
                tierId: i.tier.id,
                quantity: i.quantity,
                unitPriceCents: i.tier.priceCents,
            })), code);
        },
        pay(actor, orderId) {
            sweep();
            const order = own(actor, orderId);
            if (order.status !== "held")
                throw new OrderError("conflict", "order is not held");
            order.status = "paid";
            order.paidAt = new Date(clock()).toISOString();
            return order;
        },
        cancel(actor, orderId) {
            sweep();
            const order = own(actor, orderId);
            if (order.status === "held") {
                order.status = "cancelled";
            }
            else if (order.status === "paid") {
                const starts = Date.parse(eventOf(order.eventId).startsAt);
                if (starts - clock() <= REFUND_CUTOFF_MS) {
                    throw new OrderError("conflict", "refunds close 24 hours before the event");
                }
                order.status = "refunded";
            }
            else {
                throw new OrderError("conflict", `order is ${order.status}`);
            }
            serveWaitlist(order.eventId);
            return order;
        },
        get(actor, orderId) {
            sweep();
            const order = orders.find((o) => o.id === orderId);
            if (order === undefined || actor === undefined) {
                throw new OrderError("not_found", "order not found");
            }
            if (order.customerId !== actor.id) {
                const organizer = actor.role === "organizer" && eventOf(order.eventId).organizerId === actor.id;
                if (!organizer)
                    throw new OrderError("not_found", "order not found");
            }
            return order;
        },
        mine(actor) {
            const customer = requireCustomer(actor);
            sweep();
            return orders
                .map((o, index) => ({ o, index }))
                .filter(({ o }) => o.customerId === customer.id)
                .toSorted((a, b) => {
                const byTime = Date.parse(b.o.createdAt) - Date.parse(a.o.createdAt);
                return byTime !== 0 ? byTime : b.index - a.index;
            })
                .map(({ o }) => o);
        },
        joinWaitlist(actor, eventId, input) {
            const customer = requireCustomer(actor);
            if (typeof input !== "object" || input === null || Array.isArray(input)) {
                bad("body must be an object");
            }
            const { tierId, quantity } = input;
            if (typeof tierId !== "string" || tierId.length < 1)
                bad("tierId is required");
            if (!isInt(quantity, 1, MAX_TICKETS_PER_EVENT))
                bad("quantity must be an integer 1-6");
            sweep();
            const event = eventOf(eventId);
            const tier = event.tiers.find((t) => t.id === tierId);
            if (tier === undefined)
                bad("tier does not belong to this event");
            if (!openForSale(event))
                throw new OrderError("conflict", "event is not on sale");
            if (tier.available >= quantity) {
                throw new OrderError("conflict", "tickets are available; place an order instead");
            }
            if (waiting.some((w) => w.eventId === eventId && w.tierId === tierId && w.customerId === customer.id)) {
                throw new OrderError("conflict", "already on the waitlist for this tier");
            }
            const entry = {
                id: createId(),
                eventId,
                tierId,
                customerId: customer.id,
                quantity,
                createdAt: new Date(clock()).toISOString(),
            };
            waiting.push(entry);
            return position(entry);
        },
        myWaitlist(actor) {
            const customer = requireCustomer(actor);
            sweep();
            return waiting.filter((w) => w.customerId === customer.id).map(position);
        },
        report(actor, eventId) {
            if (actor === undefined || actor.role !== "organizer") {
                throw new OrderError("forbidden", "organizer only");
            }
            sweep();
            const event = eventOf(eventId);
            if (event.organizerId !== actor.id)
                throw new OrderError("forbidden", "not your event");
            const mineOrders = orders.filter((o) => o.eventId === eventId);
            const qty = (status, tierId) => mineOrders
                .filter((o) => o.status === status)
                .flatMap((o) => o.items)
                .filter((i) => i.tierId === tierId)
                .reduce((sum, i) => sum + i.quantity, 0);
            const sum = (status, pick) => mineOrders.filter((o) => o.status === status).reduce((s, o) => s + pick(o), 0);
            return {
                eventId,
                tiers: event.tiers.map((t) => ({
                    tierId: t.id,
                    name: t.name,
                    sold: qty("paid", t.id),
                    held: qty("held", t.id),
                    available: t.available,
                })),
                grossCents: sum("paid", (o) => o.subtotalCents),
                discountCents: sum("paid", (o) => o.discountCents),
                netCents: sum("paid", (o) => o.totalCents),
                refundedCents: sum("refunded", (o) => o.totalCents),
            };
        },
    };
}
