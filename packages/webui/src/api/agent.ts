import { ChatPL } from "../types/ChatPL";

function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("agent", 1);
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

export async function getCurrentAgentId(): Promise<string | null> {
  const db = await openDB();
  return new Promise<string>((resolve, reject) => {
    const request = db
      .transaction("config", "readwrite")
      .objectStore("config")
      .get("current-agent-id");
    request.onsuccess = () => {
      resolve((request.result as { key: string; value: string })?.value);
    };
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function setCurrentAgentId(id: string | null | undefined) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("config", "readwrite")
      .objectStore("config")
      .put({ key: "current-agent-id", value: id });
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function getAgentList(): Promise<ChatPL.AgentPO[]> {
  const db = await openDB();
  return new Promise<ChatPL.AgentPO[]>((resolve, reject) => {
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

export async function addAgent(agent: ChatPL.AgentPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .add(agent);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function editAgent(agent: ChatPL.AgentPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .put(agent);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function deleteAgent(id: string) {
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

export async function getAgent(id: string): Promise<ChatPL.AgentPO | null> {
  const db = await openDB();
  return new Promise<ChatPL.AgentPO>((resolve, reject) => {
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
