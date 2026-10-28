import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectDatabaseEmulator, getDatabase } from "firebase/database";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

const requiredConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export function getFirebaseServices(appName = "[DEFAULT]") {
  const missing = Object.entries(requiredConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing Firebase configuration: ${missing.join(", ")}. Copy .env.example to .env and add your web app settings.`);
  }

  const app = appName === "[DEFAULT]"
    ? initializeApp(requiredConfig)
    : initializeApp(requiredConfig, appName);
  const auth = getAuth(app);
  const db = getDatabase(app);
  const functions = getFunctions(app, "asia-south1");

  if (import.meta.env.VITE_FIREBASE_EMULATORS === "true") {
    if (!requiredConfig.projectId.startsWith("demo-")) {
      throw new Error("Firebase emulator mode requires a demo-* project ID to prevent access to production data.");
    }
    const emulatorHost = window.location.hostname;
    connectAuthEmulator(auth, `${window.location.protocol}//${emulatorHost}:9099`, {
      disableWarnings: true,
    });
    connectDatabaseEmulator(db, emulatorHost, 9000);
    connectFunctionsEmulator(functions, emulatorHost, 5001);
  } else if (import.meta.env.VITE_LOCAL_FUNCTIONS_EMULATOR === "true") {
    throw new Error("The legacy Functions-only emulator setting is unsafe. Start the isolated demo emulators with npm.cmd run backend:lan and npm.cmd run dev:lan.");
  }

  return {
    auth,
    db,
    functions,
  };
}
