const PASSWORD = "QuayeWorks";

const defaultFlags = {
    showDevPanel: false,
    showGameplayHud: true,
    showDebugHud: false,
    showCompass: true,
    showPOIDebug: false,
    showCullDebug: false,
    biomeDebug: false,
    cameraColliderDebug: false,
    logCollisionRecovery: false,
    localSimulation: false,
    flyMode: false,
};

let unlocked = false;
const subscribers = new Set();
const flags = { ...defaultFlags };

function notify(change) {
    subscribers.forEach((cb) => {
        try {
            cb(change || { flags: { ...flags }, unlocked });
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(err);
        }
    });
}

export const DebugSettings = {
    isUnlocked() {
        return unlocked;
    },

    unlock(password) {
        if (password === PASSWORD) {
            unlocked = true;
            notify({ unlocked, flags: { ...flags } });
            return true;
        }
        return false;
    },

    lock() {
        unlocked = false;
        notify({ unlocked, flags: { ...flags } });
    },

    getFlag(name) {
        return flags[name];
    },

    setFlag(name, value, { force = false } = {}) {
        if (!(force || unlocked)) return;
        if (!(name in flags)) return;
        const next = !!value;
        if (flags[name] === next) return;
        flags[name] = next;
        notify({ name, value: next, flags: { ...flags }, unlocked });
    },

    forceSetFlag(name, value) {
        this.setFlag(name, value, { force: true });
    },

    getAllFlags() {
        return { ...flags };
    },

    subscribe(cb) {
        if (typeof cb !== "function") return () => {};
        subscribers.add(cb);
        cb({ flags: { ...flags }, unlocked });
        return () => subscribers.delete(cb);
    },
};
