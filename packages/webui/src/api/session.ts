import { ChatPL } from "../types/ChatPL";

function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("session", 1);
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

export async function getCurrentSessionId(): Promise<string | null> {
  const db = await openDB();
  return new Promise<string>((resolve, reject) => {
    const request = db
      .transaction("config", "readwrite")
      .objectStore("config")
      .get("current-session-id");
    request.onsuccess = () => {
      resolve((request.result as { key: string; value: string })?.value);
    };
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function setCurrentSessionId(id: string | null | undefined) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("config", "readwrite")
      .objectStore("config")
      .put({ key: "current-session-id", value: id });
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function getSessionList(): Promise<ChatPL.SessionPO[]> {
  const db = await openDB();
  return new Promise<ChatPL.SessionPO[]>((resolve, reject) => {
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

export async function addSession(session: ChatPL.SessionPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .add(session);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function editSession(session: ChatPL.SessionPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .put(session);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function deleteSession(id: string) {
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

export async function getSession(id: string): Promise<ChatPL.SessionPO | null> {
  const db = await openDB();
  return new Promise<ChatPL.SessionPO>((resolve, reject) => {
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
