// src/ui_dom/AbilityTreePanel.js
// Minimal DOM-driven ability tree listing with unlock controls.

function createNodeElement(node, state, onUnlock, availability) {
    const item = document.createElement("div");
    item.className = "ability-tree-node";

    const header = document.createElement("div");
    header.className = "ability-tree-node-header";
    header.textContent = `${node.name} (${node.specialization})`;
    item.appendChild(header);

    const desc = document.createElement("div");
    desc.className = "ability-tree-node-desc";
    desc.textContent = node.description;
    item.appendChild(desc);

    const prereq = document.createElement("div");
    prereq.className = "ability-tree-node-prereq";
    prereq.textContent = node.prerequisites?.length
        ? `Requires: ${node.prerequisites.join(", ")}`
        : "No prerequisites";
    item.appendChild(prereq);

    const actionRow = document.createElement("div");
    actionRow.className = "ability-tree-node-actions";
    const cost = document.createElement("span");
    cost.textContent = `${node.cost ?? 0} SP`;
    const button = document.createElement("button");
    const locked = state.unlocked.has(node.id);
    let label = locked ? "Unlocked" : "Unlock";
    if (!locked && availability && !availability.ok) {
        if (availability.reason === "skillpoints") label = "Need SP";
        if (availability.reason === "prereq") label = "Requires prereq";
    }
    button.textContent = label;
    button.disabled = locked || (availability && !availability.ok);

    button.addEventListener("click", () => {
        onUnlock(node.id);
    });

    actionRow.appendChild(cost);
    actionRow.appendChild(button);
    item.appendChild(actionRow);

    return item;
}

export function createAbilityTreePanel({ abilityTree }) {
    const root = document.createElement("div");
    root.id = "ability-tree-panel";
    root.className = "hud-hidden";

    const title = document.createElement("div");
    title.className = "ability-tree-title";
    title.textContent = "Nen Specializations";
    root.appendChild(title);

    const controls = document.createElement("div");
    controls.className = "ability-tree-controls";
    const specializationSelect = document.createElement("select");
    controls.appendChild(specializationSelect);
    const pointsText = document.createElement("span");
    pointsText.className = "ability-tree-points";
    controls.appendChild(pointsText);
    root.appendChild(controls);

    const list = document.createElement("div");
    list.className = "ability-tree-list";
    root.appendChild(list);

    document.body.appendChild(root);

    let activeTree = null;
    let unsubscribe = null;

    function refresh(state) {
        if (!state) return;
        list.innerHTML = "";
        pointsText.textContent = `Skill Points: ${state.skillPoints ?? 0}`;

        specializationSelect.innerHTML = "";
        (activeTree?.nenTypes || []).forEach((type) => {
            const opt = document.createElement("option");
            opt.value = type;
            opt.textContent = type;
            opt.selected = type === state.specialization;
            specializationSelect.appendChild(opt);
        });

        for (const node of state.nodes) {
            if (node.specialization && node.specialization !== state.specialization) continue;
            const availability = activeTree?.canUnlock?.(node.id);
            const el = createNodeElement(node, state, (id) => activeTree?.unlock?.(id), availability);
            list.appendChild(el);
        }
    }

    specializationSelect.addEventListener("change", () => {
        activeTree?.setSpecialization?.(specializationSelect.value);
    });

    function bindTree(tree) {
        if (unsubscribe) unsubscribe();
        activeTree = tree;
        if (activeTree?.onChange) {
            unsubscribe = activeTree.onChange(refresh);
        }
    }

    bindTree(abilityTree);

    let visible = false;
    function setVisible(isVisible) {
        visible = !!isVisible;
        root.classList.toggle("hud-hidden", !visible);
    }

    window.addEventListener("keydown", (ev) => {
        if (ev.code === "KeyK") {
            setVisible(!visible);
        }
    });

    return { setVisible, refresh, setAbilityTree: bindTree };
}
