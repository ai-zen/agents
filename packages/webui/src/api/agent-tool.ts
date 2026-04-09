import { ChatPL } from "../types/ChatPL";

function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("agent-tool", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("list")) {
        db.createObjectStore("list", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("config")) {
        db.createObjectStore("config", { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = reject;
  });
}

export async function getAgentToolList(): Promise<ChatPL.AgentToolPO[]> {
  const db = await openDB();
  return new Promise<ChatPL.AgentToolPO[]>((resolve, reject) => {
    const request = db
      .transaction("list", "readonly")
      .objectStore("list")
      .getAll();
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function addAgentTool(agentTool: ChatPL.AgentToolPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .add(agentTool);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function editAgentTool(agentTool: ChatPL.AgentToolPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .put(agentTool);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function deleteAgentTool(id: string) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .delete(id);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function getAgentTool(
  id: string,
): Promise<ChatPL.AgentToolPO | null> {
  const db = await openDB();
  return new Promise<ChatPL.AgentToolPO>((resolve, reject) => {
    const request = db
      .transaction("list", "readonly")
      .objectStore("list")
      .get(id);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = reject;
  }).finally(() => db.close());
}
