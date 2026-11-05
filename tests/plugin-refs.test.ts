/**
 * A plugin passed by module (`VexOptions.plugins`): the engine imports
 * it itself, from its default export, so another thread can import the
 * same plugin from the same reference.
 */

import { afterEach, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";

let open: Vex[] = [];
afterEach(async () => {
  await Promise.all(open.map((v) => v.close()));
  open = [];
});

const ref = (name: string) =>
  new URL(`./fixtures/refs/${name}.ts`, import.meta.url);

test("a plugin passed by module is the module's default export, reading the env", async () => {
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    env: { place: "a module" } as never,
    plugins: [ref("greeter")],
  });
  open.push(vex);
  expect(await vex.query("greeter.hello")).toBe("hello from a module");
});

test("a module may give several plugins, functions and definitions alike; by module and by value mix", async () => {
  const vex = await Vex.create({
    storage: sqliteAdapter(":memory:"),
    plugins: [
      ref("pair"),
      ref("greeter").pathname,
      (api) => {
        api.setName("inline");
        api.registerQuery("n", { args: {}, handler: () => 3 });
      },
    ],
  });
  open.push(vex);
  expect(await vex.query("one.n")).toBe(1);
  expect(await vex.query("two.n")).toBe(2);
  expect(await vex.query("inline.n")).toBe(3);
  expect(vex.listPlugins().map((p) => p.name)).toEqual([
    "one",
    "two",
    "greeter",
    "inline",
  ]);
});

test("a module without a plugin to give, or a relative path, is refused, saying why", async () => {
  await expect(
    Vex.create({ storage: sqliteAdapter(":memory:"), plugins: [ref("empty")] }),
  ).rejects.toThrow("has no default export of a plugin");
  await expect(
    Vex.create({
      storage: sqliteAdapter(":memory:"),
      plugins: ["./fixtures/refs/greeter.ts"],
    }),
  ).rejects.toThrow(
    'plugin module "./fixtures/refs/greeter.ts" is relative: pass new URL(path, import.meta.url)',
  );
});
