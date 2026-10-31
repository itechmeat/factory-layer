import { randomUUID } from "node:crypto";

export type Role = "organizer" | "customer";

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  password: string;
}

export interface Store {
  users: Map<string, StoredUser>;
  usersByEmail: Map<string, string>;
  tokens: Map<string, string>;
}

export function createId(): string {
  return randomUUID();
}

export function createStore(): Store {
  return { users: new Map(), usersByEmail: new Map(), tokens: new Map() };
}

export const store: Store = createStore();
