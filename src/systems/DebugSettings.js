const PASSWORD = "QuayeWorks";

const defaultFlags = {
    showDevPanel: false,
    showGameplayHud: true,
    showDebugHud: false,
    showCompass: true,
    showPOIDebug: false,
    showCullDebug: false,
    showStreamingRings: false,
    verboseStreamingLogs: false,
    biomeDebug: false,
    cameraColliderDebug: false,
    logCollisionRecovery: false,
    localSimulation: false,
    flyMode: false,
};

const defaultValues = {
    flySpeed: 60,
};

let unlocked = false;
const subscribers = new Set();
const flags = { ...defaultFlags };
const values = { ...defaultValues };

function notify(change) {
    subscribers.forEach((cb) => {
        try {
            cb(change || { flags: { ...flags }, values: { ...values }, unlocked });
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
            notify({ unlocked, flags: { ...flags }, values: { ...values } });
            return true;
        }
        return false;
    },

    lock() {
        unlocked = false;
        notify({ unlocked, flags: { ...flags }, values: { ...values } });
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
        notify({ name, value: next, flags: { ...flags }, values: { ...values }, unlocked });
    },

    forceSetFlag(name, value) {
        this.setFlag(name, value, { force: true });
    },

    getAllFlags() {
        return { ...flags };
    },

    getValue(name) {
        return values[name];
    },

    setValue(name, value, { force = false } = {}) {
        if (!(force || unlocked)) return;
        if (!(name in values)) return;
        const next = Number(value);
        if (Number.isNaN(next)) return;
        if (values[name] === next) return;
        values[name] = next;
        notify({ name, value: next, flags: { ...flags }, values: { ...values }, unlocked });
    },

    forceSetValue(name, value) {
        this.setValue(name, value, { force: true });
    },

    getAllValues() {
        return { ...values };
    },

    subscribe(cb) {
        if (typeof cb !== "function") return () => {};
        subscribers.add(cb);
        cb({ flags: { ...flags }, values: { ...values }, unlocked });
        return () => subscribers.delete(cb);
    },
};
