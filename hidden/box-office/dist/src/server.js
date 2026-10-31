import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { cancelEvent, createDiscount, createEvent, EventError, getEvent, listEvents, } from "./domain/events.js";
import { createOrders, OrderError } from "./domain/orders.js";
import { authenticate, createUser, login, UserError } from "./domain/users.js";
import { createStore } from "./store.js";
const STATUS = {
    validation: 400,
    auth: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    unprocessable: 422,
};
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = "HttpError";
        this.status = status;
    }
}
function statusOf(error) {
    if (error instanceof HttpError)
        return error.status;
    if (error instanceof UserError || error instanceof EventError || error instanceof OrderError) {
        return STATUS[error.kind];
    }
    return 500;
}
const ok = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });
function requireActor(req, role) {
    if (req.actor === undefined)
        throw new HttpError(401, "authentication required");
    if (role !== undefined && req.actor.role !== role)
        throw new HttpError(403, `${role} only`);
    return req.actor;
}
function route(method, path, handler) {
    return {
        method,
        pattern: new RegExp(`^${path.replace(/:id/g, "([^/]+)")}$`),
        handler,
    };
}
const eventId = (req) => req.params[0] ?? "";
function buildRoutes(store, events, orders) {
    return [
        route("POST", "/users", (req) => created(createUser(store, req.json()))),
        route("POST", "/sessions", (req) => ok(login(store, req.json()))),
        route("GET", "/me", (req) => ok(requireActor(req))),
        route("POST", "/events", (req) => created(createEvent(events, requireActor(req, "organizer"), req.json()))),
        route("GET", "/events", (req) => ok(listEvents(events, req.query))),
        route("GET", "/events/:id", (req) => ok(getEvent(events, eventId(req)))),
        route("POST", "/events/:id/cancel", (req) => ok(cancelEvent(events, requireActor(req, "organizer"), eventId(req)))),
        route("POST", "/events/:id/discounts", (req) => created(createDiscount(events, requireActor(req, "organizer"), eventId(req), req.json()))),
        route("POST", "/events/:id/waitlist", (req) => {
            const actor = requireActor(req, "customer");
            return created(orders.joinWaitlist(actor, eventId(req), req.json()));
        }),
        route("GET", "/events/:id/report", (req) => ok(orders.report(requireActor(req, "organizer"), eventId(req)))),
        route("POST", "/orders", (req) => {
            const actor = requireActor(req, "customer");
            const body = req.json();
            const id = typeof body === "object" && body !== null
                ? body["eventId"]
                : "";
            if (typeof id !== "string" || id.length < 1)
                throw new HttpError(400, "eventId is required");
            return created(orders.hold(actor, id, body));
        }),
        route("POST", "/orders/:id/pay", (req) => ok(orders.pay(requireActor(req), eventId(req)))),
        route("POST", "/orders/:id/cancel", (req) => ok(orders.cancel(requireActor(req), eventId(req)))),
        route("GET", "/orders/:id", (req) => ok(orders.get(requireActor(req), eventId(req)))),
        route("GET", "/me/orders", (req) => ok(orders.mine(requireActor(req, "customer")))),
        route("GET", "/me/waitlist", (req) => ok(orders.myWaitlist(requireActor(req, "customer")))),
    ];
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
function parseJson(text) {
    if (text.trim() === "")
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        throw new HttpError(400, "body is not valid JSON");
    }
}
function queryOf(params) {
    const query = {};
    for (const key of new Set(params.keys())) {
        const all = params.getAll(key);
        query[key] = all.length === 1 ? (all[0] ?? "") : all;
    }
    return query;
}
function bearer(req) {
    const header = req.headers.authorization;
    const match = header === undefined ? null : /^Bearer (.+)$/i.exec(header);
    return match?.[1];
}
function send(res, reply) {
    const payload = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
}
function dispatch(routes, store, req, raw) {
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const r of routes) {
        const match = r.method === req.method ? r.pattern.exec(url.pathname) : null;
        if (match === null)
            continue;
        const token = bearer(req);
        const actor = authenticate(store, token);
        if (token !== undefined && actor === undefined) {
            throw new HttpError(401, "invalid token");
        }
        const params = match.slice(1).map((p) => decodeURIComponent(p));
        return r.handler({
            actor,
            params,
            query: queryOf(url.searchParams),
            json: () => parseJson(raw),
        });
    }
    throw new HttpError(404, "route not found");
}
export function createApp(config) {
    const store = createStore();
    let events = { store };
    const orders = createOrders({ store, config, events: () => events });
    events = { store, orders: orders.port };
    const routes = buildRoutes(store, events, orders);
    const server = createServer((req, res) => {
        readBody(req)
            .then((raw) => send(res, dispatch(routes, store, req, raw)))
            .catch((error) => {
            const status = statusOf(error);
            const message = status === 500 ? "internal error" : error.message;
            send(res, { status, body: { error: message } });
        });
    });
    return { server, store };
}
function isEntryPoint() {
    const argv1 = process.argv[1];
    if (argv1 === undefined)
        return false;
    try {
        return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (isEntryPoint()) {
    const config = loadConfig(process.env);
    createApp(config).server.listen(config.port, () => {
        console.log(`box-office listening on ${config.port}`);
    });
}
