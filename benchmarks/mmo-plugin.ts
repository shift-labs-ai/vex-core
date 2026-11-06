/**
 * A world, as an MMO server keeps it: players in zones, parties and
 * guilds, with inventories and zone chat. Every view a client holds
 * open is a live query here; every tick of play is a write.
 *
 * Shared by the main engine and its evaluation workers
 * (`mmo-setup.ts`).
 */

import type { VexPluginAPI } from "../src/core/api.js";

export const ZONE_SIZE = 100;
export const PARTY_SIZE = 5;
export const GUILD_SIZE = 50;
export const ITEMS_PER_PLAYER = 20;

export const zoneOf = (player: number) => `z${Math.floor(player / ZONE_SIZE)}`;
export const partyOf = (player: number) =>
  `p${Math.floor(player / PARTY_SIZE)}`;
export const guildOf = (player: number) =>
  `g${Math.floor(player / GUILD_SIZE)}`;
export const playerId = (player: number) => `pl${player}`;
/** Interest management: the world in cells, each a view its players share. */
export const CELL = 100;
export const cellOf = (x: number, y: number) =>
  `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

export function mmoPlugin(api: VexPluginAPI) {
  api.setName("mmo");
  api.registerTable("players", {
    columns: {
      name: { type: "string" },
      zone: { type: "string", index: true },
      partyId: { type: "string", index: true },
      guildId: { type: "string", index: true },
      level: { type: "number", index: true },
      x: { type: "number" },
      y: { type: "number" },
      cell: { type: "string" },
      hp: { type: "number" },
    },
    indexes: [["idx_players_zone_cell", ["zone", "cell"]]],
  });
  api.registerTable("items", {
    columns: {
      playerId: { type: "string", index: true },
      kind: { type: "string" },
      qty: { type: "number" },
    },
  });
  api.registerTable("messages", {
    columns: {
      channel: { type: "string", index: true },
      playerId: { type: "string" },
      text: { type: "string" },
      at: { type: "number" },
    },
    indexes: [["idx_messages_channel_at", ["channel", "at"]]],
  });

  // ─── A player's own views ───
  api.registerQuery("self", {
    args: { id: "string" },
    handler: (ctx, args) =>
      ctx.db.table("players").where("_id", "=", args.id).first(),
  });
  api.registerQuery("inventory", {
    args: { id: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("items")
        .where("playerId", "=", args.id)
        .order("kind", "asc")
        .all(),
  });
  api.registerQuery("inventoryCount", {
    args: { id: "string" },
    handler: (ctx, args) =>
      ctx.db.table("items").where("playerId", "=", args.id).count(),
  });
  api.registerQuery("weapons", {
    args: { id: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("items")
        .select("kind", "qty")
        .where("playerId", "=", args.id)
        .where("kind", "=", "weapon")
        .all(),
  });

  // ─── Views many players share ───
  api.registerQuery("zoneRoster", {
    args: { zone: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("players")
        .select("_id", "name", "x", "y", "hp")
        .where("zone", "=", args.zone)
        .limit(ZONE_SIZE * 2)
        .all(),
  });
  api.registerQuery("nearby", {
    args: { zone: "string", cell: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("players")
        .select("_id", "x", "y")
        .where("zone", "=", args.zone)
        .where("cell", "=", args.cell)
        .all(),
  });
  api.registerQuery("zoneChat", {
    args: { zone: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("messages")
        .select("playerId", "text", "at")
        .where("channel", "=", args.zone)
        .order("at", "desc")
        .limit(50)
        .all(),
  });
  api.registerQuery("party", {
    args: { partyId: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("players")
        .select("_id", "name", "zone", "hp", "level")
        .where("partyId", "=", args.partyId)
        .all(),
  });
  api.registerQuery("partyHp", {
    args: { partyId: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("players")
        .select("_id", "hp")
        .where("partyId", "=", args.partyId)
        .all(),
  });
  api.registerQuery("guildRoster", {
    args: { guildId: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("players")
        .select("_id", "name", "level")
        .where("guildId", "=", args.guildId)
        .order("level", "desc")
        .all(),
  });
  api.registerQuery("guildChat", {
    args: { guildId: "string" },
    handler: (ctx, args) =>
      ctx.db
        .table("messages")
        .select("playerId", "text", "at")
        .where("channel", "=", args.guildId)
        .order("at", "desc")
        .limit(50)
        .all(),
  });
  api.registerQuery("leaderboard", {
    args: {},
    handler: (ctx) =>
      ctx.db
        .table("players")
        .select("name", "level")
        .order("level", "desc")
        .limit(10)
        .all(),
  });

  // ─── Ticks of play ───
  api.registerMutation("move", {
    args: { id: "string", x: "number", y: "number" },
    handler: (ctx, args) =>
      ctx.db
        .table("players")
        .update(args.id, {
          x: args.x,
          y: args.y,
          cell: cellOf(args.x, args.y),
        }),
  });
  api.registerMutation("damage", {
    args: { id: "string", hp: "number" },
    handler: (ctx, args) =>
      ctx.db.table("players").update(args.id, { hp: args.hp }),
  });
  api.registerMutation("levelUp", {
    args: { id: "string", level: "number" },
    handler: (ctx, args) =>
      ctx.db.table("players").update(args.id, { level: args.level }),
  });
  api.registerMutation("say", {
    args: {
      channel: "string",
      playerId: "string",
      text: "string",
      at: "number",
    },
    handler: (ctx, args) => ctx.db.table("messages").insert(args),
  });
  api.registerMutation("loot", {
    args: { playerId: "string", kind: "string", qty: "number" },
    handler: (ctx, args) => ctx.db.table("items").insert(args),
  });
}
