import { DebugSettings } from "../debug/DebugSettings.js";

export class DebugMenu {
    constructor({ options = [], onVisibilityChange = null } = {}) {
        this.options = options;
        this.onVisibilityChange = onVisibilityChange;
        this.visible = false;
        this.wasPointerLocked = false;

        this.canvas = document.getElementById("renderCanvas");

        this.root = document.createElement("div");
        this.root.id = "debug-menu";
        this.root.className = "hud-hidden";

        this._buildHeader();
        this._buildPasswordGate();
        this._buildOptionsList();

        document.body.appendChild(this.root);

        this._subscription = DebugSettings.subscribe((state) => this._syncFromSettings(state));
        window.addEventListener("keydown", (ev) => this._handleKeydown(ev));
    }

    destroy() {
        this._subscription?.();
        this.root?.remove?.();
    }

    _buildHeader() {
        const header = document.createElement("div");
        header.className = "debug-menu-header";

        const title = document.createElement("div");
        title.className = "debug-menu-title";
        title.textContent = "Debug Menu";

        this.lockState = document.createElement("div");
        this.lockState.className = "debug-menu-lock-state";
        this.lockState.textContent = "Locked";

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "debug-menu-close";
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", () => this.hide());

        header.appendChild(title);
        header.appendChild(this.lockState);
        header.appendChild(closeBtn);
        this.root.appendChild(header);
    }

    _buildPasswordGate() {
        const gate = document.createElement("div");
        gate.className = "debug-menu-gate";

        this.passwordInput = document.createElement("input");
        this.passwordInput.type = "password";
        this.passwordInput.placeholder = "Password";
        this.passwordInput.autocomplete = "off";

        this.unlockBtn = document.createElement("button");
        this.unlockBtn.type = "button";
        this.unlockBtn.textContent = "Unlock";
        this.unlockBtn.addEventListener("click", () => this._unlock());

        this.lockBtn = document.createElement("button");
        this.lockBtn.type = "button";
        this.lockBtn.textContent = "Lock";
        this.lockBtn.addEventListener("click", () => DebugSettings.lock());

        this.gateMessage = document.createElement("div");
        this.gateMessage.className = "debug-menu-msg";

        gate.appendChild(this.passwordInput);
        gate.appendChild(this.unlockBtn);
        gate.appendChild(this.lockBtn);
        gate.appendChild(this.gateMessage);
        this.root.appendChild(gate);
    }

    _buildOptionsList() {
        this.optionsContainer = document.createElement("div");
        this.optionsContainer.className = "debug-menu-options";

        this.optionRows = new Map();

        this.options.forEach((opt) => {
            const row = document.createElement("div");
            row.className = "debug-menu-row";

            const label = document.createElement("div");
            label.className = "debug-menu-label";
            label.textContent = opt.label;

            let control = null;
            if (opt.type === "button") {
                control = document.createElement("button");
                control.type = "button";
                control.className = "debug-menu-button";
                control.textContent = opt.buttonLabel || "Run";
                control.addEventListener("click", () => {
                    if (!DebugSettings.isUnlocked()) return;
                    opt.onClick?.();
                });
            } else {
                control = document.createElement("label");
                control.className = "debug-menu-toggle";

                const input = document.createElement("input");
                input.type = "checkbox";
                input.addEventListener("change", () => {
                    DebugSettings.setFlag(opt.key, input.checked);
                });

                const slider = document.createElement("span");
                slider.className = "slider";

                control.appendChild(input);
                control.appendChild(slider);

                this.optionRows.set(opt.key, { row, input });
            }

            row.appendChild(label);
            row.appendChild(control);
            this.optionsContainer.appendChild(row);
        });

        this.root.appendChild(this.optionsContainer);
    }

    _handleKeydown(ev) {
        if (ev.code !== "Backquote" || !ev.shiftKey) return;
        ev.preventDefault();
        if (this.visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    show() {
        this.visible = true;
        this.wasPointerLocked = !!document.pointerLockElement;
        try {
            document.exitPointerLock?.();
        } catch (e) {
            // ignore
        }
        this.root.classList.remove("hud-hidden");
        this.onVisibilityChange?.(true);
    }

    hide() {
        this.visible = false;
        this.root.classList.add("hud-hidden");
        if (this.wasPointerLocked && this.canvas?.requestPointerLock) {
            try {
                this.canvas.requestPointerLock();
            } catch (e) {
                // ignore re-lock failures
            }
        }
        this.onVisibilityChange?.(false);
    }

    _unlock() {
        const success = DebugSettings.unlock(this.passwordInput.value);
        if (!success) {
            this.gateMessage.textContent = "Incorrect password";
            this.gateMessage.classList.add("error");
            return;
        }
        this.gateMessage.textContent = "Unlocked";
        this.gateMessage.classList.remove("error");
    }

    _syncFromSettings({ flags = {}, unlocked }) {
        this.lockState.textContent = unlocked ? "Unlocked" : "Locked";
        this.root.classList.toggle("locked", !unlocked);
        this.unlockBtn.disabled = unlocked;
        this.passwordInput.disabled = unlocked;
        this.lockBtn.disabled = !unlocked;

        this.optionRows.forEach((entry, key) => {
            if (!entry?.input) return;
            entry.input.checked = !!flags[key];
            entry.input.disabled = !unlocked;
        });
    }
}
