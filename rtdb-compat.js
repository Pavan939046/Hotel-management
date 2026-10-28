import {
  get as getValue,
  onValue,
  ref,
  runTransaction,
  set,
  update,
  serverTimestamp as rtdbServerTimestamp,
} from "firebase/database";

function encodeKey(value) {
  return value.replaceAll(".", ",");
}

function timestampValue(value) {
  if (typeof value !== "number") return value;
  return {
    seconds: Math.floor(value / 1000),
    toDate: () => new Date(value),
  };
}

function normalizeData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value || {};
  const data = { ...value };
  for (const field of ["createdAt", "updatedAt", "completedAt", "deliveredAt"]) {
    data[field] = timestampValue(data[field]);
  }
  if (data.items && !Array.isArray(data.items) && typeof data.items === "object") {
    data.items = Object.values(data.items);
  }
  return data;
}

function makeDocumentSnapshot(database, path, key, value) {
  const exists = value !== null && value !== undefined;
  const data = normalizeData(value);
  return {
    id: key,
    ref: doc(database, path),
    exists: () => exists,
    data: () => data,
    get: (field) => data?.[field],
  };
}

export function collection(database, path) {
  return { database, path, kind: "collection" };
}

export function doc(database, collectionPath, documentId) {
  const path = documentId === undefined
    ? collectionPath.split("/").map(encodeKey).join("/")
    : `${collectionPath}/${encodeKey(String(documentId))}`;
  return { database, path, kind: "document" };
}

export function where(field, operator, value) {
  return { field, operator, value };
}

export function query(reference, ...constraints) {
  return { ...reference, constraints };
}

function documentsFromValue(database, path, value, constraints = []) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .map(([key, child]) => makeDocumentSnapshot(database, `${path}/${key}`, key, child))
    .filter((snapshot) => constraints.every((constraint) => {
      if (constraint.operator === ">=") {
        const fieldValue = snapshot.get(constraint.field);
        const milliseconds = typeof fieldValue?.toDate === "function"
          ? fieldValue.toDate().getTime()
          : fieldValue;
        return milliseconds >= constraint.value.milliseconds;
      }
      return true;
    }));
}

export function onSnapshot(reference, onNext, onError) {
  return onValue(
    ref(reference.database, reference.path),
    (snapshot) => {
      const value = snapshot.val();
      if (reference.kind === "document") {
        const key = reference.path.split("/").at(-1);
        onNext(makeDocumentSnapshot(reference.database, reference.path, key, value));
      } else {
        const docs = documentsFromValue(
          reference.database,
          reference.path,
          value,
          reference.constraints || [],
        );
        onNext({
          docs,
          size: docs.length,
        });
      }
    },
    onError,
  );
}

export async function getDoc(reference) {
  const snapshot = await getValue(ref(reference.database, reference.path));
  const key = reference.path.split("/").at(-1);
  return makeDocumentSnapshot(reference.database, reference.path, key, snapshot.val());
}

export async function getDocs(reference) {
  const snapshot = await getValue(ref(reference.database, reference.path));
  return {
    docs: documentsFromValue(reference.database, reference.path, snapshot.val()),
  };
}

export async function setDoc(reference, value) {
  return set(ref(reference.database, reference.path), value);
}

export async function updateDoc(reference, value) {
  return update(ref(reference.database, reference.path), value);
}

export async function createDocIfAbsent(reference, value) {
  const result = await runTransaction(
    ref(reference.database, reference.path),
    (current) => current === null ? value : undefined,
  );
  return result.committed;
}

export function serverTimestamp() {
  return rtdbServerTimestamp();
}

export const Timestamp = {
  fromDate(date) {
    return { milliseconds: date.getTime() };
  },
};
