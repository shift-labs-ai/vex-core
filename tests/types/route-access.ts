/**
 * Compile-time tests for route access, checked by `bun run typecheck`.
 * Every `@ts-expect-error` must be an error: one that compiles fails the
 * check, so each line below proves a mistake does not build.
 */

import { createRouter, type Router } from "../../src/http/router.js";

/** An app's declaration. */
type Access = { permission: string } | "public";

const ok = () => new Response("ok");

// ─── A router typed with an access type ───

const app = createRouter<Access>();
app.get("/notes", { access: { permission: "notes.read" } }, ok);
app.post("/notes", { access: { permission: "notes.write" } }, ok, ok);
app.get("/health", { access: "public" }, ok).head("/health", { access: "public" }, ok);

// A route without a declaration does not build.
// @ts-expect-error access is required
app.get("/open", ok);

// Nor one whose declaration is not the app's.
// @ts-expect-error not an Access
app.post("/odd", { access: "anyone" }, ok);

// Nor options with no handler after them.
// @ts-expect-error a handler is required
app.put("/empty", { access: "public" });

// A loop's routes are held to it the same way.
for (const verb of ["send", "edit"]) {
  // @ts-expect-error access is required
  app.post(`/verbs/${verb}`, ok);
}

// A guard reads the app's own access type.
app.guard((_ctx, route) => {
  const access: Access | undefined = route.access;
  void access;
});

// A typed router is not an untyped one: handing it to code that
// registers routes without access does not build.
function mountUndeclared(router: Router) {
  router.get("/undeclared", ok);
}
// @ts-expect-error a typed router is not an untyped one
mountUndeclared(app);

// A router mounts its own kind, or an untyped one, whose routes its
// guards then see without access; never one declaring something else.
app.mount("/inner", createRouter<Access>().get("/x", { access: "public" }, ok));
app.mount("/legacy", createRouter().get("/x", ok));
// @ts-expect-error another app's declarations
app.mount("/other", createRouter<{ scope: string }>());

// ─── An untyped router keeps today's shape ───

const plain = createRouter();
plain.get("/hello", ok);
// @ts-expect-error an untyped router takes handlers alone
plain.get("/hello", { access: "public" }, ok);
