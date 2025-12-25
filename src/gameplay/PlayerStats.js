// src/gameplay/PlayerStats.js
// Core player stats and derived movement/resource values.

export class PlayerStats {
    constructor(config = {}) {
        this.level = 1;
        this.currentXP = 0;
        this.xpBase = config.xpBase ?? 100;
        this.xpGrowth = config.xpGrowth ?? 1.4;

        this.stats = {
            power: config.power ?? 10,
            agility: config.agility ?? 10,
            focus: config.focus ?? 10
        };

        this.skillPoints = config.skillPoints ?? 0;

        this.externalModifiers = {
            walkSpeedMultiplier: 1,
            runSpeedMultiplier: 1,
            jumpImpulseMultiplier: 1,
            gravityMultiplier: 1,
            nenRegenMultiplier: 1,
            nenRegenFlat: 0,
            carveRadiusMultiplier: 1,
            carveCostMultiplier: 1,
            cooldownScaleMultiplier: 1
        };

        this.xpToNext = this.computeXpToNext();

        this.baseMovement = {
            walkSpeed: config.baseMovement?.walkSpeed ?? 2,
            runSpeed: config.baseMovement?.runSpeed ?? 6,
            jumpImpulse: config.baseMovement?.jumpImpulse ?? 10,
            gravity: config.baseMovement?.gravity ?? 10,
            accel: config.baseMovement?.accel ?? 20,
            groundFriction: config.baseMovement?.groundFriction ?? 8,
            airFriction: config.baseMovement?.airFriction ?? 1
        };

        this.baseCarve = {
            radius: config.baseCarve?.radius ?? 70,
            nenCost: config.baseCarve?.nenCost ?? 12
        };

        this.maxHealth = config.maxHealth ?? 100;
        this.maxNen = config.maxNen ?? 100;
        this.health = this.maxHealth;
        this.nen = this.maxNen;

        this.healthRegenPerSec = config.healthRegenPerSec ?? 0.5;
        this.baseNenRegenPerSec = config.baseNenRegenPerSec ?? 12;
    }

    toSnapshot() {
        return {
            level: this.level,
            currentXP: this.currentXP,
            xpBase: this.xpBase,
            xpGrowth: this.xpGrowth,
            stats: { ...this.stats },
            skillPoints: this.skillPoints,
            maxHealth: this.maxHealth,
            maxNen: this.maxNen,
            health: this.health,
            nen: this.nen,
            baseMovement: { ...this.baseMovement },
            baseCarve: { ...this.baseCarve },
            healthRegenPerSec: this.healthRegenPerSec,
            baseNenRegenPerSec: this.baseNenRegenPerSec
        };
    }

    applySnapshot(snapshot = {}) {
        if (!snapshot) return;
        this.level = snapshot.level ?? this.level;
        this.currentXP = snapshot.currentXP ?? this.currentXP;
        this.xpBase = snapshot.xpBase ?? this.xpBase;
        this.xpGrowth = snapshot.xpGrowth ?? this.xpGrowth;
        this.stats = { ...this.stats, ...(snapshot.stats || {}) };
        this.skillPoints = snapshot.skillPoints ?? this.skillPoints;
        this.maxHealth = snapshot.maxHealth ?? this.maxHealth;
        this.maxNen = snapshot.maxNen ?? this.maxNen;
        this.health = snapshot.health ?? this.maxHealth;
        this.nen = snapshot.nen ?? this.maxNen;
        this.baseMovement = { ...this.baseMovement, ...(snapshot.baseMovement || {}) };
        this.baseCarve = { ...this.baseCarve, ...(snapshot.baseCarve || {}) };
        this.healthRegenPerSec = snapshot.healthRegenPerSec ?? this.healthRegenPerSec;
        this.baseNenRegenPerSec = snapshot.baseNenRegenPerSec ?? this.baseNenRegenPerSec;
        this.xpToNext = this.computeXpToNext();
    }

    computeXpToNext(levelOverride) {
        const level = levelOverride ?? this.level;
        return Math.floor(this.xpBase * Math.pow(level, this.xpGrowth));
    }

    addXP(amount) {
        if (!amount || amount <= 0) return;
        this.currentXP += amount;

        let xpNeeded = this.computeXpToNext();
        while (this.currentXP >= xpNeeded) {
            this.currentXP -= xpNeeded;
            this.level++;
            this._onLevelUp();
            xpNeeded = this.computeXpToNext();
        }

        this.xpToNext = this.computeXpToNext();
    }

    _onLevelUp() {
        // Simple progression: small increases to stats and caps.
        this.stats.power += 1;
        this.stats.agility += 1;
        this.stats.focus += 1;

        this.skillPoints = (this.skillPoints ?? 0) + 1;

        this.maxHealth += 5;
        this.maxNen += 5;
        this.health = this.maxHealth;
        this.nen = this.maxNen;
    }

    spendNen(cost) {
        if (cost <= 0) return true;
        if (this.nen < cost) return false;
        this.nen -= cost;
        return true;
    }

    applyDamage(amount) {
        if (amount <= 0) return;
        this.health = Math.max(0, this.health - amount);
    }

    update(dtSeconds) {
        if (dtSeconds <= 0) return;

        // Passive regeneration
        this.nen = Math.min(this.maxNen, this.nen + this.getNenRegenPerSec() * dtSeconds);
        this.health = Math.min(this.maxHealth, this.health + this.healthRegenPerSec * dtSeconds);
    }

    getNenRegenPerSec() {
        const focusFactor = 1 + this.stats.focus * 0.03;
        const regenFromStats = this.baseNenRegenPerSec * focusFactor;
        return regenFromStats * (this.externalModifiers.nenRegenMultiplier ?? 1)
            + (this.externalModifiers.nenRegenFlat ?? 0);
    }

    getDerived() {
        const agilityFactor = 1 + this.stats.agility * 0.02;
        const powerFactor = 1 + this.stats.power * 0.025;
        const focusFactor = 1 + this.stats.focus * 0.02;

        const gravityScale = Math.max(0.6, 1 - this.stats.agility * 0.01) * (this.externalModifiers.gravityMultiplier ?? 1);
        const airControlMultiplier = 1 + this.stats.agility * 0.02;
        const carveRadiusMultiplier = (1 + this.stats.power * 0.015) * (this.externalModifiers.carveRadiusMultiplier ?? 1);
        const carveCostMultiplier = Math.max(0.5, 1 - this.stats.power * 0.01) * (this.externalModifiers.carveCostMultiplier ?? 1);

        const cooldownScale = Math.max(
            0.45,
            Math.max(0.6, 1 - focusFactor * 0.05) * (this.externalModifiers.cooldownScaleMultiplier ?? 1)
        );

        return {
            level: this.level,
            currentXP: this.currentXP,
            xpToNext: this.xpToNext,
            stats: { ...this.stats },
            skillPoints: this.skillPoints,
            health: this.health,
            nen: this.nen,
            maxHealth: this.maxHealth,
            maxNen: this.maxNen,
            nenRegenPerSec: this.getNenRegenPerSec(),
            walkSpeed: this.baseMovement.walkSpeed * agilityFactor * (this.externalModifiers.walkSpeedMultiplier ?? 1),
            runSpeed: this.baseMovement.runSpeed * agilityFactor * (this.externalModifiers.runSpeedMultiplier ?? 1),
            jumpImpulse: this.baseMovement.jumpImpulse * powerFactor * (this.externalModifiers.jumpImpulseMultiplier ?? 1),
            gravity: this.baseMovement.gravity * gravityScale,
            accel: this.baseMovement.accel * agilityFactor,
            groundFriction: this.baseMovement.groundFriction,
            airFriction: this.baseMovement.airFriction * airControlMultiplier,
            carveRadiusMultiplier,
            carveCostMultiplier,
            cooldownScale,
            nenRegenMultiplier: focusFactor
        };
    }

    setExternalModifiers(mods = {}) {
        this.externalModifiers = {
            ...this.externalModifiers,
            ...mods
        };
    }
}
