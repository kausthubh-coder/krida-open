// The timeline's pictures, kept on this device per file as small JPEGs (about 10 KB each), so a film watched before
// has them from its first second and asks for nothing. A film at one picture every 10 s is about 12 MB, an episode
// about 3 MB; the 20 files used last are kept.

const DB = "krida-previews";
const KEEP_FILES = 20;

let opening: Promise<IDBDatabase | null> | null = null;

function open() {
  opening ??= new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("frames");
      req.result.createObjectStore("files");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return opening;
}

const done = <T,>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const ofFile = (file: number) => IDBKeyRange.bound([file, 0], [file, Infinity]);

/** The pictures kept for a file, by their place in its index. Marks the file as used. */
export async function keptPictures(file: number): Promise<Map<number, Blob>> {
  const db = await open();
  const kept = new Map<number, Blob>();
  if (!db) return kept;
  const tx = db.transaction(["frames", "files"], "readwrite");
  const [keys, blobs] = await Promise.all([done(tx.objectStore("frames").getAllKeys(ofFile(file))), done(tx.objectStore("frames").getAll(ofFile(file)))]);
  keys.forEach((key, i) => kept.set((key as [number, number])[1], blobs[i] as Blob));
  tx.objectStore("files").put(Date.now(), file);
  void prune(db);
  return kept;
}

/** A picture as a small JPEG, the way it's kept here and in memory. */
export async function toJpeg(bitmap: ImageBitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
}

/** Keeps one picture of a file. */
export async function keepPicture(file: number, index: number, blob: Blob) {
  const db = await open();
  if (!db) return;
  const tx = db.transaction(["frames", "files"], "readwrite");
  tx.objectStore("frames").put(blob, [file, index]);
  tx.objectStore("files").put(Date.now(), file);
}

/** Lets go of the files used longest ago, past the newest 20. */
async function prune(db: IDBDatabase) {
  const tx = db.transaction(["frames", "files"], "readwrite");
  const files = tx.objectStore("files");
  const [keys, used] = await Promise.all([done(files.getAllKeys()), done(files.getAll())]);
  const old = keys.map((file, i) => ({ file: file as number, used: used[i] as number })).sort((a, b) => b.used - a.used).slice(KEEP_FILES);
  for (const { file } of old) {
    files.delete(file);
    tx.objectStore("frames").delete(ofFile(file));
  }
}
