// src/gameplay/AbilityTree.js
// Minimal ability tree system that layers Nen specializations on top of base stats/abilities.

const DEFAULT_NEN_TYPES = [
    "Enhancement",
    "Transmutation",
    "Conjuration",
    "Manipulation",
    "Emission"
];

function buildDefaultNodes() {
    return [
        {
            id: "enhancement_foundation",
            name: "Reinforced Core",
            description: "Slightly improve mobility and Nen upkeep.",
            specialization: "Enhancement",
            cost: 1,
            prerequisites: [],
            effects: {
                walkSpeedMultiplier: 1.04,
                runSpeedMultiplier: 1.05,
                nenRegenMultiplier: 1.05
            }
        },
        {
            id: "enhancement_sprint",
            name: "Burst Stride",
            description: "Sprint faster with better Nen control.",
            specialization: "Enhancement",
            cost: 1,
            prerequisites: ["enhancement_foundation"],
            effects: {
                runSpeedMultiplier: 1.06,
                ability: { sprintSpeedMultiplier: 1.15, sprintNenCostMultiplier: 0.9 }
            }
        },
        {
            id: "transmutation_feather",
            name: "Feather Step",
            description: "Jump abilities last longer and hit higher.",
            specialization: "Transmutation",
            cost: 1,
            prerequisites: [],
            effects: {
                jumpImpulseMultiplier: 1.08,
                ability: { jumpDurationMultiplier: 1.25, jumpMultiplier: 1.05 }
            }
        },
        {
            id: "conjuration_edge",
            name: "Carve Edge",
            description: "Sharper carves with reduced Nen cost.",
            specialization: "Conjuration",
            cost: 1,
            prerequisites: [],
            effects: {
                carveRadiusMultiplier: 1.12,
                carveCostMultiplier: 0.9,
                ability: { carveRadiusMultiplier: 1.08, carveNenCostMultiplier: 0.9 }
            }
        },
        {
            id: "emission_focus",
            name: "Flow Control",
            description: "Cooldowns recover faster and Nen returns quicker.",
            specialization: "Emission",
            cost: 1,
            prerequisites: [],
            effects: {
                cooldownScaleMultiplier: 0.9,
                nenRegenFlat: 2
            }
        },
        {
            id: "manipulation_chain",
            name: "Battle Rhythm",
            description: "Ability uptime improves and jump/carve recover sooner.",
            specialization: "Manipulation",
            cost: 2,
            prerequisites: ["enhancement_foundation", "emission_focus"],
            effects: {
                cooldownScaleMultiplier: 0.85,
                ability: { jumpCooldownMultiplier: 0.8, carveCooldownMultiplier: 0.85 }
            }
        }
    ];
}

export class AbilityTreeSystem {
    constructor({ playerStats, abilities, nenTypes = DEFAULT_NEN_TYPES } = {}) {
        this.playerStats = playerStats;
        this.abilities = abilities;
        this.nenTypes = nenTypes;
        this.specialization = nenTypes[0];
        this.nodes = buildDefaultNodes();
        this.unlocked = new Set();
        this.listeners = [];
        this.lastKnownSkillPoints = this.playerStats?.skillPoints ?? 0;
        this._applyEffects();
    }

    setSpecialization(type) {
        if (this.nenTypes.includes(type)) {
            this.specialization = type;
            this._emit();
        }
    }

    getNodes() {
        return this.nodes;
    }

    getState() {
        return {
            specialization: this.specialization,
            unlocked: new Set(this.unlocked),
            nodes: this.nodes.slice(),
            skillPoints: this.playerStats?.skillPoints ?? 0
        };
    }

    tick() {
        const points = this.playerStats?.skillPoints ?? 0;
        if (points !== this.lastKnownSkillPoints) {
            this.lastKnownSkillPoints = points;
            this._emit();
        }
    }

    canUnlock(nodeId) {
        const node = this.nodes.find((n) => n.id === nodeId);
        if (!node) return { ok: false, reason: "unknown" };
        if (this.unlocked.has(nodeId)) return { ok: false, reason: "unlocked" };
        if ((this.playerStats?.skillPoints ?? 0) < (node.cost || 0)) return { ok: false, reason: "skillpoints" };
        const missing = (node.prerequisites || []).filter((id) => !this.unlocked.has(id));
        if (missing.length > 0) return { ok: false, reason: "prereq", missing };
        return { ok: true, reason: "ok" };
    }

    unlock(nodeId) {
        const check = this.canUnlock(nodeId);
        if (!check.ok) return check;
        const node = this.nodes.find((n) => n.id === nodeId);
        this.unlocked.add(nodeId);
        if (this.playerStats) {
            this.playerStats.skillPoints = Math.max(0, (this.playerStats.skillPoints ?? 0) - (node.cost || 0));
        }
        this._applyEffects();
        this._emit();
        return { ok: true, reason: "ok" };
    }

    reset() {
        this.unlocked.clear();
        this._applyEffects();
        this._emit();
    }

    _combineEffects() {
        const total = {
            walkSpeedMultiplier: 1,
            runSpeedMultiplier: 1,
            jumpImpulseMultiplier: 1,
            gravityMultiplier: 1,
            nenRegenMultiplier: 1,
            nenRegenFlat: 0,
            carveRadiusMultiplier: 1,
            carveCostMultiplier: 1,
            cooldownScaleMultiplier: 1,
            ability: {
                sprintSpeedMultiplier: 1,
                sprintNenCostMultiplier: 1,
                jumpDurationMultiplier: 1,
                jumpCooldownMultiplier: 1,
                jumpNenCostMultiplier: 1,
                jumpMultiplier: 1,
                carveDurationMultiplier: 1,
                carveCooldownMultiplier: 1,
                carveNenCostMultiplier: 1,
                carveRadiusMultiplier: 1,
                carveCostMultiplier: 1
            }
        };

        for (const node of this.nodes) {
            if (!this.unlocked.has(node.id)) continue;
            const effects = node.effects || {};
            for (const [key, value] of Object.entries(effects)) {
                if (key === "ability") continue;
                if (typeof total[key] === "number" && typeof value === "number") {
                    // Multiplicative or additive depending on baseline
                    total[key] = key.includes("Flat") ? total[key] + value : total[key] * value;
                }
            }
            const ability = effects.ability || {};
            for (const [aKey, aValue] of Object.entries(ability)) {
                if (typeof total.ability[aKey] === "number" && typeof aValue === "number") {
                    total.ability[aKey] *= aValue;
                }
            }
        }

        return total;
    }

    _applyEffects() {
        const combined = this._combineEffects();
        if (this.playerStats?.setExternalModifiers) {
            this.playerStats.setExternalModifiers({
                walkSpeedMultiplier: combined.walkSpeedMultiplier,
                runSpeedMultiplier: combined.runSpeedMultiplier,
                jumpImpulseMultiplier: combined.jumpImpulseMultiplier,
                gravityMultiplier: combined.gravityMultiplier,
                nenRegenMultiplier: combined.nenRegenMultiplier,
                nenRegenFlat: combined.nenRegenFlat,
                carveRadiusMultiplier: combined.carveRadiusMultiplier,
                carveCostMultiplier: combined.carveCostMultiplier,
                cooldownScaleMultiplier: combined.cooldownScaleMultiplier
            });
        }
        if (this.abilities?.applyExternalModifiers) {
            this.abilities.applyExternalModifiers(combined);
        }
        this.activeEffects = combined;
        this.lastKnownSkillPoints = this.playerStats?.skillPoints ?? this.lastKnownSkillPoints;
    }

    toSnapshot() {
        return {
            specialization: this.specialization,
            unlocked: Array.from(this.unlocked)
        };
    }

    applySnapshot(snapshot = {}) {
        if (!snapshot) return;
        this.unlocked = new Set(snapshot.unlocked || []);
        if (snapshot.specialization && this.nenTypes.includes(snapshot.specialization)) {
            this.specialization = snapshot.specialization;
        }
        this._applyEffects();
        this._emit();
    }

    onChange(cb) {
        if (typeof cb !== "function") return () => {};
        this.listeners.push(cb);
        cb(this.getState());
        return () => {
            this.listeners = this.listeners.filter((f) => f !== cb);
        };
    }

    _emit() {
        const state = this.getState();
        this.listeners.forEach((fn) => fn(state));
    }
}
