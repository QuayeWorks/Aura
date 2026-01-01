// src/ui/NPCDialog.js
// DOM dialog + vendor panel for settlement NPCs.

export function createNPCDialog() {
    let root = document.getElementById("npc-dialog");
    if (!root) {
        root = document.createElement("div");
        root.id = "npc-dialog";
        root.className = "hud-panel hud-hidden npc-dialog";
        document.body.appendChild(root);
    }

    const title = document.createElement("div");
    title.className = "npc-title";
    const lines = document.createElement("div");
    lines.className = "npc-lines";
    const vendorSection = document.createElement("div");
    vendorSection.className = "npc-vendor";

    root.appendChild(title);
    root.appendChild(lines);
    root.appendChild(vendorSection);

    let visible = false;
    let onClose = null;

    function setVisible(isVisible) {
        visible = !!isVisible;
        root.classList.toggle("hud-hidden", !visible);
        if (!visible && onClose) onClose();
    }

    function renderDialog({ name = "", dialogLines = [], vendor = null, inventory } = {}) {
        title.textContent = name ? `${name}` : "NPC";
        lines.innerHTML = "";
        dialogLines.forEach((line) => {
            const p = document.createElement("div");
            p.textContent = line;
            lines.appendChild(p);
        });

        vendorSection.innerHTML = "";
        if (vendor) {
            const currency = document.createElement("div");
            currency.className = "npc-currency";
            currency.textContent = `Tokens: ${inventory?.tokens ?? 0}`;
            vendorSection.appendChild(currency);

            const list = document.createElement("div");
            list.className = "npc-vendor-list";
            vendor.items.forEach((item) => {
                const entry = document.createElement("div");
                entry.className = "npc-item";
                const title = document.createElement("span");
                title.textContent = `${item.name} (${item.price}T)`;
                const btn = document.createElement("button");
                btn.textContent = "Buy";
                btn.addEventListener("click", () => vendor.onBuy?.(item));
                entry.appendChild(title);
                entry.appendChild(btn);

                if (inventory?.hasItem?.(item.name)) {
                    const sellBtn = document.createElement("button");
                    sellBtn.textContent = "Sell";
                    sellBtn.addEventListener("click", () => vendor.onSell?.(item));
                    entry.appendChild(sellBtn);
                }
                list.appendChild(entry);
            });
            vendorSection.appendChild(list);
        }
    }

    function bindClose(handler) {
        onClose = handler;
    }

    return { setVisible, renderDialog, bindClose };
}
