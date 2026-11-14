import { getControllerInfo } from "@launchpad/services";
import { Elysia } from "elysia";

// A fetch handler only: the parent TanStack Start server owns the listener.
export const api = new Elysia({ prefix: "/api" }).get("/health", getControllerInfo);
