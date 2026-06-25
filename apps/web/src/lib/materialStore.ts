export type StoredMaterial = {
  id: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string;
  file: Blob;
  pages?: StoredPage[];
  ocrCompleted?: boolean;
};

export type StoredPage = {
  pageNumber: number;
  title: string;
  text: string;
};

const DATABASE = "noosphere-materials";
const STORE = "materials";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local material storage."));
  });
}

export async function storeMaterial(file: File, pages: StoredPage[]): Promise<StoredMaterial> {
  const material: StoredMaterial = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    type: file.type || "application/pdf",
    size: file.size,
    uploadedAt: new Date().toISOString(),
    file,
    pages,
    ocrCompleted: true
  };
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(material);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the PDF."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving the PDF was cancelled."));
  });
  database.close();
  return material;
}

export async function updateMaterial(material: StoredMaterial): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(material);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not update the PDF index."));
  });
  database.close();
}

export async function listMaterials(): Promise<StoredMaterial[]> {
  const database = await openDatabase();
  const materials = await new Promise<StoredMaterial[]>((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as StoredMaterial[]);
    request.onerror = () => reject(request.error ?? new Error("Could not read saved PDFs."));
  });
  database.close();
  return materials;
}
