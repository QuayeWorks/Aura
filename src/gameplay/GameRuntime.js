// src/gameplay/GameRuntime.js
// Wires player stats, abilities, HUD, and terrain interactions together.

import { PlayerStats } from "./PlayerStats.js";
import { Abilities } from "./Abilities.js";
import { CarveController } from "./CarveController.js";
import { POIManager } from "../world/POIManager.js";
import { EnemyManager } from "../enemies/EnemyManager.js";
import { AbilityTreeSystem } from "./AbilityTree.js";
import { Inventory } from "./Inventory.js";
import { SettlementSystem } from "../world/SettlementSystem.js";
import { LocalMultiplayerSim, NetEventBus, NetSyncController } from "../multiplayer/NetModel.js";

export class GameRuntime {
    constructor({ player, terrain, hud, baseMovement, baseCarve, scene, dayNightSystem, saveSystem } = {}) {
        this.player = player;
        this.terrain = terrain;
        this.hud = hud;
        this.scene = scene;
        this.dayNightSystem = dayNightSystem;
        this.saveSystem = saveSystem;

        this.playerStats = new PlayerStats({
            baseMovement: {
                walkSpeed: baseMovement?.walkSpeed ?? player?.walkSpeed ?? 2,
                runSpeed: baseMovement?.runSpeed ?? player?.runSpeed ?? 6,
                jumpImpulse: baseMovement?.jumpImpulse ?? player?.jumpSpeed ?? 10,
                gravity: baseMovement?.gravity ?? player?.gravity ?? 10,
                accel: baseMovement?.accel ?? player?.accel ?? 20,
                groundFriction: baseMovement?.groundFriction ?? player?.groundFriction ?? 8,
                airFriction: baseMovement?.airFriction ?? player?.airFriction ?? 1
            },
            baseCarve: {
                radius: baseCarve?.radius ?? 70,
                nenCost: baseCarve?.nenCost ?? 12
            }
        });

        this.abilities = new Abilities(this.playerStats, {
            sprintNenPerSecond: 10,
            sprintSpeedMultiplier: 1.25,
            jumpDuration: 4,
            jumpCooldown: 7,
            jumpNenCost: 18,
            jumpMultiplier: 1.5,
            carveDuration: 5,
            carveCooldown: 8,
            carveNenCost: 22,
            carveRadiusMultiplier: 1.4,
            carveCostMultiplier: 0.65
        });

        this.abilityTree = new AbilityTreeSystem({
            playerStats: this.playerStats,
            abilities: this.abilities
        });

        this.inventory = new Inventory({ startingTokens: 80 });

        this.enabled = true;
        this.timeSinceHudUpdate = 0;

        this.carveController = new CarveController({
            terrain: this.terrain,
            playerStats: this.playerStats,
            abilities: this.abilities,
            hud: this.hud,
            baseRadius: baseCarve?.radius ?? 70,
            baseNenCost: baseCarve?.nenCost ?? 12
        });

        this.poiManager = new POIManager({
            scene,
            terrain,
            player,
            seed: terrain?.seed ?? 1,
            planetRadius: terrain?.radius ?? 1
        });
        this.enemyManager = new EnemyManager({
            scene,
            terrain,
            player,
            planetRadius: terrain?.radius ?? 1,
            playerStats: this.playerStats,
            dayNightSystem: this.dayNightSystem,
            spawnRadius: 10,
            maxEnemies: 2
        });

        this.settlementSystem = new SettlementSystem({
            scene,
            terrain,
            player,
            poiManager: this.poiManager,
            inventory: this.inventory,
            hud: this.hud,
        });

        this.localPlayerId = "player-local";
        this.localCarveSeq = 0;
        this.netBus = new NetEventBus();
        this.netSync = new NetSyncController({ terrain: this.terrain, saveSystem, localPlayerId: this.localPlayerId });
        this.netSync.attachTo(this.netBus);
        this.localSim = new LocalMultiplayerSim({
            scene,
            terrain,
            player,
            planetRadius: terrain?.radius ?? 1,
            eventBus: this.netBus
        });
        this.localSimEnabled = false;
    }

    getSnapshot() {
        const stats = this.playerStats?.toSnapshot?.();
        const abilityState = this.getAbilityState();
        const abilityTree = this.abilityTree?.toSnapshot?.();
        const inventory = this.inventory?.toSnapshot?.();
        return { stats, abilities: abilityState, abilityTree, inventory };
    }

    applySnapshot(snapshot = {}) {
        if (snapshot.stats && this.playerStats?.applySnapshot) {
            this.playerStats.applySnapshot(snapshot.stats);
        }
        if (snapshot.abilityTree && this.abilityTree?.applySnapshot) {
            this.abilityTree.applySnapshot(snapshot.abilityTree);
        }
        if (snapshot.inventory && this.inventory?.applySnapshot) {
            this.inventory.applySnapshot(snapshot.inventory);
        }
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        this.abilities?.setEnabled(this.enabled);
        if (this.carveController) this.carveController.enabled = this.enabled;
        if (this.poiManager) this.poiManager.enabled = this.enabled;
        if (this.enemyManager) this.enemyManager.enabled = this.enabled;
        if (!this.enabled) {
            this.localSim?.setEnabled(false);
        } else if (this.localSimEnabled) {
            this.localSim?.setEnabled(true);
        }
        if (!this.enabled && this.hud) {
            this.hud.setGameplayVisible(false);
        }
    }

    setLocalSimEnabled(isEnabled) {
        this.localSimEnabled = !!isEnabled;
        this.localSim?.setEnabled(this.localSimEnabled);
    }

    toggleLocalSim() {
        this.setLocalSimEnabled(!this.localSimEnabled);
    }

    update(dtSeconds) {
        if (!this.enabled) return;
        if (!this.player) return;

        this.playerStats.update(dtSeconds);
        this.abilities.update(dtSeconds);
        this.abilityTree?.tick?.();
        this.carveController?.update(dtSeconds);
        this.poiManager?.update(dtSeconds);
        this.enemyManager?.update(dtSeconds);
        this.settlementSystem?.update(dtSeconds);
        this.localSim?.update(dtSeconds);
        this.netSync?.update(dtSeconds);

        this._applyStatsToPlayer();
        this.timeSinceHudUpdate += dtSeconds;
        if (this.timeSinceHudUpdate > 0.08 && this.hud) {
            this._updateHud();
            this.timeSinceHudUpdate = 0;
        }
    }

    _applyStatsToPlayer() {
        if (!this.player) return;
        const derived = this.playerStats.getDerived();
        const mods = this.abilities.getMovementModifiers();

        this.player.walkSpeed = derived.walkSpeed;
        this.player.runSpeed = derived.runSpeed * mods.sprintSpeedMultiplier;
        this.player.accel = derived.accel;
        this.player.jumpSpeed = derived.jumpImpulse * mods.jumpMultiplier;
        this.player.gravity = derived.gravity;
        this.player.airFriction = derived.airFriction;
        this.player.groundFriction = derived.groundFriction;

        // Force sprint flag to follow resource/activation state
        this.player.inputRun = mods.sprintActive;
    }

    _updateHud() {
        const abilityState = this.abilities.getAbilityState();
        const derived = this.playerStats.getDerived();
        const settlementHud = this.settlementSystem?.getHUDState?.() || {};
        const remoteCount = this.netSync?.getRemotePlayerCount?.() || 0;
        const ghostCount = this.localSim?.ghosts?.length || 0;
        this.hud.update({
            health: derived.health,
            maxHealth: derived.maxHealth,
            nen: derived.nen,
            maxNen: derived.maxNen,
            level: derived.level,
            currentXP: derived.currentXP,
            xpToNext: derived.xpToNext,
            skillPoints: this.playerStats.skillPoints,
            abilityState,
            nenRegen: derived.nenRegenPerSec,
            stats: derived.stats,
            carveHeat: this.carveController?.getHeat?.(),
            tokens: this.inventory?.tokens ?? 0,
            questLine: settlementHud.questLine,
            interactionPromptText: settlementHud.prompt,
            multiplayerCount: 1 + remoteCount + ghostCount
        });
    }

    getAbilityState() {
        return this.abilities?.getAbilityState?.();
    }

    handleCarve(worldPoint) {
        if (!this.enabled) return false;
        if (!this.terrain || !worldPoint) return false;
        const result = this.carveController?.tryCarve(worldPoint);
        if (!result?.success && result?.reason === "lockout") {
            this.hud?.flashNenBar?.();
        }
        if (result?.success && this.netBus) {
            this.netBus.emit("carve", {
                playerId: this.localPlayerId || "player-local",
                seq: this.localCarveSeq = (this.localCarveSeq || 0) + 1,
                position: { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z },
                radius: result.radius,
                timestamp: performance.now(),
            });
        }
        return !!result?.success;
    }
}
