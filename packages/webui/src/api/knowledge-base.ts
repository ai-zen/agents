import { ChatPL } from "../types/ChatPL";

function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("knowledge-base", 1);
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

export async function getKnowledgeBaseList(): Promise<
  ChatPL.KnowledgeBasePO[]
> {
  const db = await openDB();
  return new Promise<ChatPL.KnowledgeBasePO[]>((resolve, reject) => {
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

export async function addKnowledgeBase(knowledgeBase: ChatPL.KnowledgeBasePO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .add(knowledgeBase);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function editKnowledgeBase(knowledgeBase: ChatPL.KnowledgeBasePO) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("list", "readwrite")
      .objectStore("list")
      .put(knowledgeBase);
    request.onsuccess = resolve;
    request.onerror = reject;
  }).finally(() => db.close());
}

export async function deleteKnowledgeBase(id: string) {
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

export async function getKnowledgeBase(
  id: string
): Promise<ChatPL.KnowledgeBasePO | null> {
  const db = await openDB();
  return new Promise<ChatPL.KnowledgeBasePO>((resolve, reject) => {
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

export async function putKnowledgeItem(
  id: string,
  item: ChatPL.KnowledgeItemPO
) {
  const kb = await getKnowledgeBase(id);
  if (!kb) throw new Error("Knowledge base not found");
  const index = kb.data.findIndex((x) => x.id === item.id);
  if (index == -1) {
    kb.data.push(item);
  } else {
    kb.data[index] = item;
  }
  await editKnowledgeBase(kb);
}
