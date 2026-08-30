import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve("local/chunk-network-entanglement-preview.html");
let html = readFileSync(target, "utf8");

const marker = "mobile-quantum-touch-zoom-20260830";
if (html.includes(marker)) {
  console.log("mobile quantum touch/zoom patch already applied");
  process.exit(0);
}

function replaceOnce(before, after, label) {
  const first = html.indexOf(before);
  if (first < 0) throw new Error(`patch anchor missing: ${label}`);
  if (html.indexOf(before, first + before.length) >= 0) throw new Error(`patch anchor is ambiguous: ${label}`);
  html = html.slice(0, first) + after + html.slice(first + before.length);
}

replaceOnce(
  '    const camera = new THREE.PerspectiveCamera(43, innerWidth / innerHeight, .1, 600);\n    camera.position.set(0, 13 * displayScale, Math.max(92, displayRadiusBounds.max * 1.36));',
  '    // mobile-quantum-touch-zoom-20260830: keep the full 10k-node field observable on compact screens.\n    const isCompactViewport = matchMedia("(max-width:700px)").matches;\n    const cameraFar = Math.max(1400, displayRadiusBounds.max * 8);\n    const camera = new THREE.PerspectiveCamera(43, innerWidth / innerHeight, .1, cameraFar);\n    const initialCameraDistance = Math.max(\n      isCompactViewport ? 150 : 92,\n      displayRadiusBounds.max * (isCompactViewport ? 1.9 : 1.36)\n    );\n    camera.position.set(0, 13 * displayScale, initialCameraDistance);',
  "camera distance"
);

replaceOnce(
  '    controls.minDistance = 13;\n    controls.maxDistance = Math.max(170, displayRadiusBounds.max * 2.5);',
  '    controls.minDistance = 13;\n    controls.maxDistance = Math.max(\n      isCompactViewport ? 480 : 220,\n      displayRadiusBounds.max * (isCompactViewport ? 5.2 : 3.1)\n    );',
  "orbit zoom range"
);

replaceOnce(
  `    function hitFromPointer() {\n      raycaster.setFromCamera(pointer, camera);\n      const hit = raycaster.intersectObjects([\n        opinionInstances,\n        entanglementInstances,\n        topicInstances,\n        root\n      ], false)[0];\n      if (!hit) return null;\n      if (hit.object === opinionInstances && Number.isInteger(hit.instanceId)) {\n        return { type:"opinion", index:hit.instanceId, id:model.nodes[hit.instanceId].id };\n      }\n      if (hit.object === entanglementInstances && Number.isInteger(hit.instanceId)) {\n        return { type:"entanglement", index:hit.instanceId, id:projection.groups[hit.instanceId].id };\n      }\n      if (hit.object === topicInstances && Number.isInteger(hit.instanceId)) {\n        return { type:"topic", index:hit.instanceId, id:topics[hit.instanceId].id };\n      }\n      return { type:"root" };\n    }`,
  `    function hitFromPointer() {\n      raycaster.setFromCamera(pointer, camera);\n      const hit = raycaster.intersectObjects([\n        opinionInstances,\n        entanglementInstances,\n        topicInstances,\n        root\n      ], false)[0];\n      if (!hit) return null;\n      if (hit.object === opinionInstances && Number.isInteger(hit.instanceId)) {\n        return { type:"opinion", index:hit.instanceId, id:model.nodes[hit.instanceId].id };\n      }\n      if (hit.object === entanglementInstances && Number.isInteger(hit.instanceId)) {\n        return { type:"entanglement", index:hit.instanceId, id:projection.groups[hit.instanceId].id };\n      }\n      if (hit.object === topicInstances && Number.isInteger(hit.instanceId)) {\n        return { type:"topic", index:hit.instanceId, id:topics[hit.instanceId].id };\n      }\n      return { type:"root" };\n    }\n    const coarsePointer = matchMedia("(pointer: coarse)").matches;\n    const screenProbe = new THREE.Vector3();\n    function hitFromScreenProximity(event) {\n      const bounds = renderer.domElement.getBoundingClientRect();\n      if (!bounds.width || !bounds.height) return null;\n      const radius = coarsePointer || event.pointerType === "touch" ? 28 : 10;\n      let best = null;\n      let bestDistanceSq = radius * radius;\n      function consider(position, type, index, id) {\n        screenProbe.copy(position).project(camera);\n        if (screenProbe.z < -1 || screenProbe.z > 1) return;\n        const x = bounds.left + (screenProbe.x + 1) * .5 * bounds.width;\n        const y = bounds.top + (1 - screenProbe.y) * .5 * bounds.height;\n        const dx = x - event.clientX;\n        const dy = y - event.clientY;\n        const distanceSq = dx * dx + dy * dy;\n        if (distanceSq > bestDistanceSq) return;\n        bestDistanceSq = distanceSq;\n        best = index == null ? { type } : { type, index, id };\n      }\n      for (let index = 0; index < renderPositions.length; index += 1) {\n        consider(renderPositions[index], "opinion", index, model.nodes[index].id);\n      }\n      for (let index = 0; index < groupRenderPositions.length; index += 1) {\n        consider(groupRenderPositions[index], "entanglement", index, projection.groups[index].id);\n      }\n      for (let index = 0; index < topicPositions.length; index += 1) {\n        consider(topicPositions[index], "topic", index, topics[index].id);\n      }\n      consider(root.position, "root", null, null);\n      return best;\n    }\n    function hitAtEvent(event) {\n      setPointer(event);\n      return hitFromPointer() || hitFromScreenProximity(event);\n    }`,
  "touch hit fallback"
);

replaceOnce(
  `    renderer.domElement.addEventListener("pointermove", setPointer);\n    renderer.domElement.addEventListener("pointerleave", () => {\n      pointer.set(2, 2);\n      pointerDirty = true;\n    });\n    renderer.domElement.addEventListener("click", () => {\n      if (!hovered) return;\n      selected = { ...hovered };\n      if (selected.type === "root") observeAll();\n      else if (selected.type === "entanglement") observeGroup(selected.id);\n      else {\n        refreshSelection();\n        if (selected.type === "opinion") appendTrace(selected, "SELECT NODE");\n      }\n      triggerRelationGlow();\n    });`,
  `    function activateSelection(next) {\n      if (!next) return;\n      selected = { ...next };\n      hovered = { ...next };\n      if (selected.type === "root") observeAll();\n      else if (selected.type === "entanglement") observeGroup(selected.id);\n      else {\n        refreshSelection();\n        if (selected.type === "opinion") appendTrace(selected, "SELECT NODE");\n      }\n      triggerRelationGlow();\n    }\n    let selectionPointerDown = null;\n    renderer.domElement.addEventListener("pointerdown", event => {\n      setPointer(event);\n      if (!event.isPrimary) return;\n      selectionPointerDown = {\n        pointerId:event.pointerId,\n        x:event.clientX,\n        y:event.clientY,\n        at:performance.now(),\n        pointerType:event.pointerType\n      };\n    });\n    renderer.domElement.addEventListener("pointermove", setPointer);\n    renderer.domElement.addEventListener("pointerleave", () => {\n      pointer.set(2, 2);\n      pointerDirty = true;\n    });\n    renderer.domElement.addEventListener("pointercancel", event => {\n      if (selectionPointerDown?.pointerId === event.pointerId) selectionPointerDown = null;\n    });\n    renderer.domElement.addEventListener("pointerup", event => {\n      const down = selectionPointerDown;\n      if (!event.isPrimary || !down || down.pointerId !== event.pointerId) return;\n      selectionPointerDown = null;\n      const movement = Math.hypot(event.clientX - down.x, event.clientY - down.y);\n      const elapsed = performance.now() - down.at;\n      const movementLimit = down.pointerType === "touch" ? 14 : 6;\n      if (movement > movementLimit || elapsed > 700) return;\n      activateSelection(hitAtEvent(event));\n    });`,
  "pointer activation"
);

writeFileSync(target, html);
console.log(`patched ${target}`);
