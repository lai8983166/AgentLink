import type { ConversationState } from "./protocol";

/** 桌面推送的 Immer 路径数组：沿路径复制，避免每个文本增量复制整个长会话。 */
export function applyConversationPatches(state: ConversationState, patches: unknown): ConversationState {
  if (!Array.isArray(patches)) throw new Error("Invalid patches");
  let next: unknown = state;
  for (const patch of patches) {
    if (!patch || !["add", "replace", "remove"].includes(patch.op) || !Array.isArray(patch.path)) throw new Error("Invalid patch");
    if (patch.path.some((part: unknown) => !(typeof part === "string" || (typeof part === "number" && Number.isInteger(part))) || ["__proto__", "constructor", "prototype"].includes(String(part)))) throw new Error("Invalid patch path");
    const apply = (node: unknown, index: number): unknown => {
      if (index === patch.path.length) {
        if (patch.op === "remove") throw new Error("Cannot remove state");
        return patch.value;
      }
      if (!node || typeof node !== "object") throw new Error("Missing patch parent");
      const key = patch.path[index] as string | number;
      const leaf = index === patch.path.length - 1;
      if (Array.isArray(node)) {
        if (typeof key !== "number" || key < 0 || key > node.length || (key === node.length && (!leaf || patch.op !== "add"))) throw new Error("Invalid array index");
        const copy = node.slice();
        if (!leaf) copy[key] = apply(node[key], index + 1);
        else if (patch.op === "add") copy.splice(key, 0, patch.value);
        else if (patch.op === "remove") copy.splice(key, 1);
        else copy[key] = patch.value;
        return copy;
      }
      const object = node as Record<string | number, unknown>;
      if ((!leaf || patch.op !== "add") && !Object.hasOwn(object, key)) throw new Error("Missing patch target");
      const copy = { ...object };
      if (!leaf) copy[key] = apply(object[key], index + 1);
      else if (patch.op === "remove") delete copy[key];
      else copy[key] = patch.value;
      return copy;
    };
    next = apply(next, 0);
  }
  if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Invalid conversation state");
  return next as ConversationState;
}
