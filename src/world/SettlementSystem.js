/* global BABYLON */
// SettlementSystem.js
// Uses POIManager hooks to spawn lightweight settlements with NPC vendors.

import { createNPCDialog } from "../ui_dom/NPCDialog.js";

const VENDOR_ITEMS = [
    { name: "Crystal Shard", price: 8 },
    { name: "Glow Petal", price: 5 },
    { name: "Stone Tablet", price: 12 },
];

function mulberry32(seed) {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

class NPC {
    constructor({ scene, position, up, name, dialogLines, vendorItems, inventory }) {
        this.scene = scene;
        this.position = position.clone();
        this.up = up.clone().normalize();
        this.name = name;
        this.dialogLines = dialogLines || [];
        this.vendorItems = vendorItems || [];
        this.interactionRadius = 40;
        this.inventory = inventory;
        this.isFrozen = false;
        this.isActive = true;

        this.mesh = BABYLON.MeshBuilder.CreateBox(
            `npc_${name}`,
            { size: 10 },
            scene
        );
        this.mesh.position.copyFrom(this.position);
        this.mesh.isPickable = false;
        this.mesh.metadata = { isNPC: true };

        this.position = this.mesh.position;

        const forward = BABYLON.Vector3.Cross(this.up, new BABYLON.Vector3(0, 1, 0));
        if (forward.lengthSquared() < 1e-4) forward.copyFromFloats(1, 0, 0);
        forward.normalize();
        const right = BABYLON.Vector3.Cross(forward, this.up).normalize();
        const rot = BABYLON.Matrix.FromXYZAxes(right, this.up, forward);
        this.mesh.rotationQuaternion = BABYLON.Quaternion.FromRotationMatrix(rot);

        const mat = new BABYLON.StandardMaterial(`npcMat_${name}`, scene);
        mat.diffuseColor = new BABYLON.Color3(0.2, 0.8, 0.5);
        mat.emissiveColor = new BABYLON.Color3(0.1, 0.5, 0.4);
        this.mesh.material = mat;
    }

    dispose() {
        this.mesh?.dispose();
    }

    setFrozen(isFrozen) {
        this.isFrozen = !!isFrozen;
    }

    setActive(isActive) {
        this.isActive = !!isActive;
    }

    applyGroundGateClamp() {
        // NPCs don't move, so nothing to clamp, but method exists for interface parity.
    }
}

export class SettlementSystem {
    constructor({ scene, terrain, player, poiManager, inventory, hud, spawnGate } = {}) {
        this.scene = scene;
        this.terrain = terrain;
        this.player = player;
        this.poiManager = poiManager;
        this.inventory = inventory;
        this.hud = hud;
        this.spawnGate = spawnGate;
        this.questGoal = { item: "Crystal Shard", required: 3 };

        this.dialog = createNPCDialog();
        this.dialog.bindClose(() => {
            this.activeNPC = null;
            this.hud?.setInteractionPrompt?.("");
            this.dialogOpen = false;
        });
        this.dialogOpen = false;

        this.settlements = new Map();
        this.activeNPC = null;

        if (this.poiManager) {
            this.poiManager.onSpawn = (plan, mesh) => this._handlePOISpawn(plan, mesh);
            this.poiManager.onDespawn = (planId) => this._handlePOIDespawn(planId);
        }

        window.addEventListener("keydown", (ev) => {
            if (ev.code === "KeyF") {
                this.tryInteract();
            }
        });
    }

    _handlePOISpawn(plan, mesh) {
        if (!plan || plan.type !== "settlement") return;
        const rng = mulberry32(plan.id.length * 17);
        const names = ["Lysa", "Corin", "Orlan", "Mira", "Tal"];
        const name = names[Math.floor(rng() * names.length)];
        const offset = mesh ? mesh.position : plan.position;
        const npcPos = offset.add(plan.up.scale(8));
        const dialogLines = [
            "Welcome, traveler! Tokens spend the same here as anywhere.",
            "Our wares are simple, but they'll aid your journey.",
        ];
        const vendorItems = VENDOR_ITEMS.map((item, idx) => ({
            ...item,
            price: item.price + Math.floor(rng() * (idx + 2)),
        }));

        const npc = new NPC({
            scene: this.scene,
            position: npcPos,
            up: plan.up,
            name,
            dialogLines,
            vendorItems,
            inventory: this.inventory
        });

        if (this.spawnGate) {
            this.spawnGate.registerActor(npc, { planetRadius: this.terrain?.radius, type: "npc" });
        }

        this.settlements.set(plan.id, { plan, mesh, npc });
    }

    _handlePOIDespawn(planId) {
        const settlement = this.settlements.get(planId);
        if (!settlement) return;
        settlement.npc?.dispose();
        this.settlements.delete(planId);
        if (this.activeNPC && this.activeNPC === settlement.npc) {
            this.dialog.setVisible(false);
            this.activeNPC = null;
        }
    }

    tryInteract() {
        if (!this.player?.mesh) return;
        if (this.dialogOpen) {
            this.dialog.setVisible(false);
            return;
        }
        const npc = this._closestNPC();
        if (!npc || this.player?.inputEnabled === false || !npc.isActive) return;
        this.activeNPC = npc;
        this.dialog.renderDialog({
            name: npc.name,
            dialogLines: npc.dialogLines,
            vendor: {
                items: npc.vendorItems,
                onBuy: (item) => this._buyItem(item),
                onSell: (item) => this._sellItem(item)
            },
            inventory: this.inventory,
        });
        this.dialog.setVisible(true);
        this.dialogOpen = true;
    }

    _buyItem(item) {
        if (!item || !this.inventory) return;
        if (this.inventory.spendTokens(item.price)) {
            this.inventory.addItem(item.name, 1);
            this.hud?.setInteractionPrompt?.(`Purchased ${item.name}`);
            this.tryInteract();
        } else {
            this.hud?.setInteractionPrompt?.("Not enough tokens");
        }
    }

    _sellItem(item) {
        if (!item || !this.inventory) return;
        if (this.inventory.removeItem(item.name, 1)) {
            this.inventory.addTokens(Math.max(1, Math.floor(item.price * 0.5)));
            this.hud?.setInteractionPrompt?.(`Sold ${item.name}`);
            this.tryInteract();
        } else {
            this.hud?.setInteractionPrompt?.("You don't own that yet");
        }
    }

    _closestNPC() {
        if (!this.player?.mesh) return null;
        const pos = this.player.mesh.position;
        let closest = null;
        let closestDist = Infinity;
        for (const [, settlement] of this.settlements) {
            const npc = settlement.npc;
            if (!npc || npc.isFrozen) continue;
            const npcPos = npc.mesh?.position || npc.position;
            if (!npcPos) continue;
            const dist = BABYLON.Vector3.Distance(pos, npcPos);
            if (dist < npc.interactionRadius && dist < closestDist) {
                closest = npc;
                closestDist = dist;
            }
        }
        this.hud?.setInteractionPrompt?.(closest ? `F – Talk to ${closest.name}` : "");
        return closest;
    }

    update() {
        if (!this.player?.mesh) return;
        this._closestNPC();
    }

    getHUDState() {
        const npc = this._closestNPC();
        const questCount = this.inventory?.items?.find((i) => i.name === this.questGoal.item)?.count || 0;
        const questLine = `${this.questGoal.item} ${questCount}/${this.questGoal.required}`;
        return {
            prompt: npc ? `F – Talk to ${npc.name}` : "",
            questLine,
        };
    }
}
