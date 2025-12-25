# Multiplayer Feasibility Notes (Phase 7 Scaffold)

## Authority and prediction
- **Authoritative server:** terrain carve log (sequence keyed per player), enemy spawn seeds per chunk, ability activation events and cooldowns.
- **Client predicted:** player movement, ability animation/FX timing, basic NPC interactions. Clients append carve intents locally while server resolves region limits and rebroadcasts filtered batches.

## Replication model
- Event bus drives: player state (pos/vel/stats delta), carve events `{playerId, seq, position, radius, timestamp}`, enemy spawns `{seed, chunkId}`.
- Append-only carve log with `(playerId, seq)` dedupe; region-capped using the same per-region compaction as saves.
- Chunk-aware streaming keeps POIs/settlements/NPCs spawn-despawned alongside terrain visibility.

## Bandwidth expectations
- Carve events: ~32 bytes payload each. Batched 4–8 per 0.5s window → ~64–128 events/minute in heavy digging (~3–5 KB/minute/player before headers).
- Player state: 10 Hz small packets (pos/vel/flags) → ~200 bytes/s/player uncompressed.
- Enemy spawns: rare (<1 per chunk entry) deterministic seeds, negligible bandwidth.

## Sync strategy
- Batch carve broadcasts per region per 0.5s; compress position vectors (quantize to cm) and radius (uint16).
- Clients throttle mesh rebuild triggers while applying batches to avoid stalls; rebuilds piggyback on existing chunk worker queue.
- Use seed-driven spawning for enemies/settlements to avoid syncing meshes or SDF fields.

## Out of scope / not synced
- Full terrain meshes or SDF fields (only carve deltas replicate).
- Audio state, cosmetic FX, or fireflies/menu visuals.
- Precise NPC AI/pathfinding (NPCs remain stationary in scaffold).
