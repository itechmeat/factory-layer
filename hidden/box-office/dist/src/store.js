import { randomUUID } from "node:crypto";
export function createId() {
    return randomUUID();
}
export function createStore() {
    return { users: new Map(), usersByEmail: new Map(), tokens: new Map() };
}
export const store = createStore();
