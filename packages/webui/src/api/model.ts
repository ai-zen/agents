import { ChatPL } from "../types/ChatPL";

function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("model", 1);
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

export async function getModelList(): Promise<ChatPL.ModelPO[]> {
  const db = await openDB();
  return new Promise<ChatPL.ModelPO[]>((resolve, reject) => {
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

export async function addModel(model: ChatPL.ModelPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .add(model);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function editModel(model: ChatPL.ModelPO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .put(model);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function deleteModel(id: string) {
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

export async function getModel(id: string): Promise<ChatPL.ModelPO | null> {
  const db = await openDB();
  return new Promise<ChatPL.ModelPO>((resolve, reject) => {
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
