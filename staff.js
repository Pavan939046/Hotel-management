import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import {
  collection,
  createDocIfAbsent,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  query,
  updateDoc,
} from "./rtdb-compat.js";
import QRCode from "qrcode";
import { httpsCallable } from "firebase/functions";
import { getFirebaseServices } from "./firebase-client.js";
import { createUuid } from "./secure-uuid.js";

const loginScreen = document.querySelector("#staff-login");
const dashboard = document.querySelector("#staff-dashboard");
const signInButton = document.querySelector("#google-sign-in");
const signOutButton = document.querySelector("#sign-out-button");
const staffMessage = document.querySelector("#staff-message");
const nav = document.querySelector("#dashboard-nav");
const orderAlert = document.querySelector("#order-alert");
const ordersMessage = document.querySelector("#orders-message");
const liveOrders = document.querySelector("#live-orders");
const overviewOrders = document.querySelector("#overview-orders");
const historyOrders = document.querySelector("#history-orders");
const historyMessage = document.querySelector("#history-message");
const tableGrid = document.querySelector("#table-grid");
const overviewTableGrid = document.querySelector("#overview-table-grid");
const qrGrid = document.querySelector("#table-qr-grid");
const tableMessage = document.querySelector("#table-message");
const tableManagementPanel = document.querySelector("#table-management-panel");
const menuList = document.querySelector("#menu-list");
const menuForm = document.querySelector("#menu-form");
const menuMessage = document.querySelector("#menu-message");
const supervisorForm = document.querySelector("#supervisor-form");
const supervisorList = document.querySelector("#supervisor-list");
const supervisorMessage = document.querySelector("#supervisor-message");
const soundToggle = document.querySelector("#sound-toggle");
const filterSelect = document.querySelector("#live-order-filter");
const historySearch = document.querySelector("#history-search");

const navItems = [
  { id: "overview", label: "Overview", icon: "◫", roles: ["admin", "supervisor", "manager"] },
  { id: "live-orders", label: "Live orders", icon: "↗", roles: ["admin", "supervisor", "manager"] },
  { id: "tables", label: "Tables & QR codes", icon: "▦", roles: ["admin", "supervisor", "manager"] },
  { id: "menu", label: "Menu management", icon: "◉", roles: ["admin", "manager"] },
  { id: "history", label: "Order history", icon: "◷", roles: ["admin", "supervisor", "manager"] },
  { id: "reports", label: "Order reports", icon: "▤", roles: ["admin", "manager"] },
  { id: "supervisors", label: "Staff access", icon: "♧", roles: ["admin"] },
  { id: "profile", label: "Profile & settings", icon: "◎", roles: ["admin", "supervisor", "manager"] },
];

let services;
let currentUser;
let role;
let handledUid;
let verifyingRole = false;
let signingOutForRevocation = false;
let signInErrorMessage = "";
let usersUnsubscribe;
let ordersUnsubscribe;
let tablesUnsubscribe;
let visitsUnsubscribe;
let supervisorsUnsubscribe;
let ordersById = new Map();
let tables = [];
let menuItems = [];
let previousOrderIds = new Set();
let firstOrderSnapshot = true;
let soundEnabled = false;
let editingMenuItemId = null;
let dailyVisits = "—";
const trustedOrderBackendEnabled = import.meta.env.VITE_TRUSTED_ORDER_BACKEND_ENABLED === "true";

const callable = (name, data = {}) => httpsCallable(services.functions, name)(data);

const money = (paise = 0) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
}).format(paise / 100);

function dayStart() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function readableError(error, fallback) {
  const message = typeof error?.message === "string" ? error.message : "";
  return message && !/^(internal|unknown)(\s|$)/i.test(message) && !message.includes("[0]")
    ? message
    : fallback;
}

function formatSignInError(error) {
  if (error?.code === "auth/popup-closed-by-user") {
    return "The Google sign-in window was closed before sign-in completed. Select Continue with Google and finish the sign-in.";
  }
  if (error?.code === "auth/popup-blocked") {
    return "The browser blocked the Google sign-in window. Allow popups for this site, then try again.";
  }
  if (error?.code === "auth/operation-not-allowed") {
    return "Google sign-in is disabled for this Firebase project. In Firebase Console, open Authentication → Sign-in method and enable Google.";
  }
  if (error?.code === "auth/unauthorized-domain") {
    return `This address (${window.location.hostname}) is not authorized for Firebase sign-in. In Firebase Console, open Authentication → Settings → Authorized domains and add "${window.location.hostname}".`;
  }
  const details = readableError(error, "Check the Firebase Authentication provider and browser connection.");
  return error?.code ? `${details} (Firebase error: ${error.code})` : details;
}

function isToday(timestamp) {
  return timestamp?.toDate instanceof Function && timestamp.toDate() >= dayStart();
}

function clearListeners() {
  usersUnsubscribe?.();
  ordersUnsubscribe?.();
  tablesUnsubscribe?.();
  visitsUnsubscribe?.();
  supervisorsUnsubscribe?.();
  usersUnsubscribe = undefined;
  ordersUnsubscribe = undefined;
  tablesUnsubscribe = undefined;
  visitsUnsubscribe = undefined;
  supervisorsUnsubscribe = undefined;
}

function setView(viewId) {
  const view = document.querySelector(`#view-${viewId}`);
  if (!view) return;
  document.querySelectorAll(".dashboard-view").forEach((section) => {
    section.hidden = section !== view;
  });
  nav.querySelectorAll("button[data-view]").forEach((button) => {
    const isActive = button.dataset.view === viewId;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });
  document.querySelector("#dashboard-kicker").textContent =
    navItems.find((item) => item.id === viewId)?.label.toUpperCase() || "WORKSPACE";
  document.querySelector("#dashboard-title").textContent =
    viewId === "overview" ? `Welcome, ${currentUser?.displayName?.split(" ")[0] || "team"}` :
      navItems.find((item) => item.id === viewId)?.label || "Workspace";
}

function renderNavigation() {
  nav.replaceChildren();
  for (const item of navItems.filter((entry) => entry.roles.includes(role))) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-item";
    button.dataset.view = item.id;
    const icon = document.createElement("span");
    icon.className = "nav-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = item.icon;
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(icon, label);
    button.addEventListener("click", () => setView(item.id));
    nav.append(button);
  }
  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "nav-item nav-logout";
  logout.innerHTML = '<span class="nav-icon" aria-hidden="true">↗</span><span>Sign out</span>';
  logout.addEventListener("click", () => signOut(services.auth));
  nav.append(logout);
}

function showLogin(message) {
  clearListeners();
  role = null;
  handledUid = undefined;
  ordersById.clear();
  tables = [];
  previousOrderIds.clear();
  firstOrderSnapshot = true;
  dailyVisits = "—";
  liveOrders.replaceChildren();
  overviewOrders.replaceChildren();
  historyOrders.replaceChildren();
  tableGrid.replaceChildren();
  overviewTableGrid.replaceChildren();
  qrGrid.replaceChildren();
  dashboard.hidden = true;
  loginScreen.hidden = false;
  document.title = "Staff sign in | Olive & Ember";
  signInButton.disabled = false;
  if (message) staffMessage.textContent = message;
}

function accessDenied() {
  signingOutForRevocation = true;
  showLogin("Access denied. Your email has not been authorized by the Admin. Please contact the administrator.");
  signOut(services.auth).finally(() => {
    signingOutForRevocation = false;
  });
}

function playNewOrderSound() {
  if (!soundEnabled) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const audio = new AudioContextClass();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, audio.currentTime);
  oscillator.frequency.setValueAtTime(1174, audio.currentTime + 0.12);
  gain.gain.setValueAtTime(0.14, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.3);
  oscillator.onended = () => audio.close();
}

function statusLabel(status) {
  return {
    new: "New",
    accepted: "Accepted",
    preparing: "Preparing",
    ready: "Ready",
    delivered: "Delivered",
    completed: "Delivered",
    rejected: "Declined",
  }[status] || "Unknown";
}

function statusClass(status) {
  return `status-${status || "unknown"}`;
}

function currentActiveOrder(tableNumber) {
  return [...ordersById.values()]
    .filter((order) => order.tableNumber === tableNumber && !["delivered", "completed", "rejected"].includes(order.status))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))[0];
}

function tableState(order) {
  if (!order) return { label: "Available", className: "available" };
  if (order.status === "ready") return { label: "Ready", className: "ready" };
  if (["delivered", "completed"].includes(order.status)) return { label: "Delivered", className: "delivered" };
  if (order.status === "preparing" || order.status === "accepted") {
    return { label: "Preparing", className: "preparing" };
  }
  return { label: "Ordering", className: "ordering" };
}

function makeTableCard(table, addAdminControl = false) {
  const order = currentActiveOrder(table.displayNumber);
  const state = tableState(order);
  const card = document.createElement("article");
  card.className = `table-card table-${state.className}${table.active ? "" : " table-inactive"}`;
  const top = document.createElement("div");
  top.className = "table-card-top";
  const number = document.createElement("strong");
  number.textContent = `T${String(table.displayNumber).padStart(2, "0")}`;
  const badge = document.createElement("span");
  badge.className = `table-state state-${table.active ? state.className : "inactive"}`;
  badge.textContent = table.active ? state.label : "Inactive";
  top.append(number, badge);
  const orderId = document.createElement("p");
  orderId.className = "table-order-id";
  orderId.textContent = order ? `#${order.id.slice(-7).toUpperCase()}` : "Ready for guests";
  const details = document.createElement("span");
  const quantity = order?.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
  details.textContent = order ? `${quantity} ${quantity === 1 ? "item" : "items"} · ${formatTime(order.createdAt)}` : "No active order";
  card.append(top, orderId, details);
  if (order) {
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Table ${table.displayNumber}, ${state.label}, open order`);
    card.addEventListener("click", () => {
      setView("live-orders");
      document.querySelector("#live-order-filter").value = "all";
      renderOrders();
      document.querySelector(`[data-order-id="${order.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    card.addEventListener("keydown", (event) => {
      if (event.target !== card) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        card.click();
      }
    });
  }
  if (addAdminControl && (role === "admin" || role === "manager")) {
    const toggle = document.createElement("button");
    toggle.className = "table-toggle";
    toggle.type = "button";
    toggle.textContent = table.active ? "Deactivate" : "Activate";
    toggle.addEventListener("click", async (event) => {
      event.stopPropagation();
      toggle.disabled = true;
      try {
        await updateDoc(doc(services.db, "tables", table.id), {
          active: !table.active,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        tableMessage.textContent = readableError(error, "Table status could not be changed. Please retry.");
      } finally {
        toggle.disabled = false;
      }
    });
    card.append(toggle);
  }
  return card;
}

function renderTables() {
  const sortedTables = [...tables].sort((a, b) => a.displayNumber - b.displayNumber);
  tableGrid.replaceChildren(...sortedTables.map((table) => makeTableCard(table, true)));
  overviewTableGrid.replaceChildren(...sortedTables.map((table) => makeTableCard(table)));
}

function formatTime(timestamp) {
  if (!timestamp?.toDate) return "just now";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(timestamp.toDate());
}

function actionButton(label, orderId, action, status) {
  const button = document.createElement("button");
  button.className = "order-action";
  button.type = "button";
  button.textContent = label;
  button.disabled = !trustedOrderBackendEnabled;
  if (!trustedOrderBackendEnabled) {
    button.title = "Deploy the trusted Realtime Database Functions before updating orders.";
  }
  button.dataset.orderId = orderId;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (!trustedOrderBackendEnabled) {
        throw new Error("Order updates require the trusted Realtime Database Functions, which are not deployed.");
      }
      await callable("updateOrder", {
        orderId,
        action,
        ...(status ? { status } : {}),
      });
    } catch (error) {
      orderAlert.textContent = readableError(error, "Order could not be updated. Please retry.");
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderOrder(order, compact = false) {
  const card = document.createElement("article");
  card.className = `staff-order-card${compact ? " compact-order" : ""}`;
  card.dataset.orderId = order.id;

  const top = document.createElement("div");
  top.className = "staff-order-top";
  const headingBlock = document.createElement("div");
  const table = document.createElement("span");
  table.className = "order-table-number";
  table.textContent = `Table ${order.tableNumber}`;
  const orderNumber = document.createElement("span");
  orderNumber.className = "staff-order-id";
  orderNumber.textContent = `#${order.id.slice(-8).toUpperCase()}`;
  headingBlock.append(table, orderNumber);
  const badge = document.createElement("span");
  badge.className = `order-status-badge ${statusClass(order.status)}`;
  badge.textContent = statusLabel(order.status);
  top.append(headingBlock, badge);

  const orderTime = document.createElement("p");
  orderTime.className = "order-time";
  orderTime.textContent = `Received ${formatTime(order.createdAt)}`;
  const items = document.createElement("ul");
  items.className = "staff-order-items";
  for (const item of order.items || []) {
    const line = document.createElement("li");
    line.innerHTML = `<span>${item.quantity} × ${escapeHtml(item.name)}</span><strong>${money(item.lineTotalPaise || item.pricePaise * item.quantity)}</strong>`;
    items.append(line);
  }
  const detail = document.createElement("div");
  detail.className = "staff-order-detail";
  const amount = document.createElement("strong");
  amount.textContent = money(order.totalPaise);
  const delivery = document.createElement("span");
  delivery.textContent = `Delivery ${["delivered", "completed"].includes(order.status) || order.deliveryConfirmed ? "confirmed" : "pending"}`;
  detail.append(amount, delivery);
  card.append(top, orderTime, items, detail);

  if (order.instructions) {
    const instructions = document.createElement("p");
    instructions.className = "order-instructions";
    instructions.textContent = `Kitchen note · ${order.instructions}`;
    card.append(instructions);
  }
  if (!compact) {
    const actions = document.createElement("div");
    actions.className = "order-actions";
    if (order.status === "new") {
      actions.append(actionButton("Start preparing", order.id, "status", "preparing"));
      actions.append(actionButton("Decline", order.id, "status", "rejected"));
    } else if (order.status === "accepted") {
      actions.append(actionButton("Start preparing", order.id, "status", "preparing"));
    } else if (order.status === "preparing") {
      actions.append(actionButton("Mark delivered", order.id, "delivery"));
    } else if (order.status === "ready") {
      actions.append(actionButton("Mark delivered", order.id, "delivery"));
    }
    if (actions.childElementCount) card.append(actions);
  }
  return card;
}

function filteredOrders(view) {
  const all = [...ordersById.values()].sort((a, b) =>
    (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  if (view === "history") return all.filter((order) => ["delivered", "completed", "rejected"].includes(order.status));
  const filter = filterSelect.value;
  if (filter === "all") return all;
  if (filter === "new") return all.filter((order) => order.status === "new");
  if (filter === "preparing") return all.filter((order) => order.status === "preparing");
  if (filter === "ready") return all.filter((order) => order.status === "ready");
  if (filter === "delivered") return all.filter((order) => ["delivered", "completed"].includes(order.status));
  return all.filter((order) => !["delivered", "completed", "rejected"].includes(order.status));
}

function renderOrders() {
  const all = [...ordersById.values()].sort((a, b) =>
    (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  const active = all.filter((order) => !["delivered", "completed", "rejected"].includes(order.status));
  const history = filteredOrders("history").filter((order) => {
    const term = historySearch.value.trim().toLowerCase();
    return !term || order.id.toLowerCase().includes(term) || `table ${order.tableNumber}`.includes(term);
  });
  const visibleLive = filteredOrders("live-orders");

  liveOrders.replaceChildren(...visibleLive.map((order) => renderOrder(order)));
  overviewOrders.replaceChildren(...active.slice(0, 3).map((order) => renderOrder(order, true)));
  historyOrders.replaceChildren(...history.map((order) => renderOrder(order, true)));
  ordersMessage.textContent = visibleLive.length ? `${visibleLive.length} orders shown` : "No orders match this filter.";
  historyMessage.textContent = history.length ? `${history.length} previous orders` : "Completed or declined orders will appear here.";

  const todayOrders = all.filter((order) => isToday(order.createdAt));
  const metrics = [
    ["New orders", todayOrders.filter((order) => order.status === "new").length, "new"],
    ["Preparing", todayOrders.filter((order) => ["accepted", "preparing"].includes(order.status)).length, "preparing"],
    ["Ready", todayOrders.filter((order) => order.status === "ready").length, "ready"],
    ["Delivered", todayOrders.filter((order) => ["delivered", "completed"].includes(order.status)).length, "delivered"],
    ["Order value today", money(todayOrders.reduce((sum, order) => sum + order.totalPaise, 0)), "sales"],
  ];
  renderMetrics(metrics, document.querySelector("#metrics-grid"));
  renderAdminMetrics();
}

function renderMetrics(metrics, target) {
  target.replaceChildren(...metrics.map(([label, value, variant]) => {
    const card = document.createElement("article");
    card.className = `metric-card metric-${variant}`;
    const title = document.createElement("span");
    title.textContent = label;
    const figure = document.createElement("strong");
    figure.textContent = String(value);
    card.append(title, figure);
    return card;
  }));
}

function renderAdminMetrics() {
  if (role !== "admin" && role !== "manager") return;
  const todayOrders = [...ordersById.values()].filter((order) =>
    isToday(order.createdAt) && order.status !== "rejected");
  const orderValue = todayOrders.reduce((sum, order) => sum + order.totalPaise, 0);
  renderMetrics([
    ["QR menu sessions", dailyVisits, "visits"],
    ["Orders today", todayOrders.length, "orders"],
    ["Order value incl. GST", money(orderValue), "sales"],
  ], document.querySelector("#report-metrics"));
  document.querySelector("#report-summary").textContent =
    `${todayOrders.length} orders · ${todayOrders.filter((order) => ["delivered", "completed"].includes(order.status)).length} delivered · ${money(orderValue)} total order value including GST`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function renderQrCodes(visibleTables) {
  if (role !== "admin" && role !== "manager") return;
  qrGrid.replaceChildren();
  const emulatorMode = import.meta.env.VITE_FIREBASE_EMULATORS === "true";
  if (emulatorMode && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
    tableMessage.textContent = "Open this staff portal using the PC's Wi-Fi IP address before generating QR codes for phones.";
    return;
  }
  const publicMenuUrl = emulatorMode
    ? window.location.origin
    : import.meta.env.VITE_PUBLIC_MENU_URL;
  for (const table of visibleTables) {
    let baseUrl;
    try {
      baseUrl = new URL(publicMenuUrl || "/", window.location.origin);
    } catch (error) {
      console.error("Table QR base URL is invalid:", error);
      tableMessage.textContent = "The table QR address is invalid. Set VITE_PUBLIC_MENU_URL to the phone-accessible menu address.";
      return;
    }
    if (!["http:", "https:"].includes(baseUrl.protocol)) {
      tableMessage.textContent = "The table QR address must use HTTP or HTTPS.";
      return;
    }
    baseUrl.search = "";
    baseUrl.hash = "";
    baseUrl.searchParams.set("table", String(table.displayNumber));
    const entry = document.createElement("article");
    entry.className = "qr-item";
    const restaurant = document.createElement("span");
    restaurant.className = "qr-restaurant-name";
    restaurant.textContent = "Olive & Ember";
    const image = document.createElement("img");
    image.alt = `QR code for Table ${table.displayNumber}`;
    try {
      image.src = await QRCode.toDataURL(baseUrl.href, {
        errorCorrectionLevel: "M",
        margin: 4,
        width: 360,
      });
    } catch (error) {
      console.error("Could not generate table QR code:", error);
      tableMessage.textContent = "A QR code could not be generated. Please retry.";
      continue;
    }
    const label = document.createElement("strong");
    label.textContent = `Table ${table.displayNumber}`;
    const destination = document.createElement("a");
    destination.className = "qr-destination";
    destination.href = baseUrl.href;
    destination.textContent = baseUrl.href;
    destination.target = "_blank";
    destination.rel = "noopener noreferrer";
    const link = document.createElement("a");
    link.href = image.src;
    link.download = `table-${table.displayNumber}-qr.png`;
    link.textContent = "Download";
    const print = document.createElement("button");
    print.type = "button";
    print.className = "qr-print-button";
    print.textContent = "Print";
    print.addEventListener("click", () => {
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        tableMessage.textContent = "Allow pop-ups to print this QR code.";
        return;
      }
      printWindow.opener = null;
      printWindow.document.write(
        `<!doctype html><title>Olive &amp; Ember — Table ${table.displayNumber} QR</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:40px;color:#213b32}p{font-size:18px;letter-spacing:.08em}img{width:360px;max-width:90vw;image-rendering:pixelated}h1{font-size:24px}</style><p>Olive &amp; Ember</p><h1>Table ${table.displayNumber}</h1><img src="${image.src}" alt="Table ${table.displayNumber} QR code"><p>${baseUrl.href}</p><script>window.onload=()=>window.print()<\/script>`,
      );
      printWindow.document.close();
    });
    entry.append(restaurant, image, label, destination, link, print);
    qrGrid.append(entry);
  }
}

function startOrdersListener() {
  ordersUnsubscribe = onSnapshot(collection(services.db, "orders"), (snapshot) => {
    const updatedOrders = new Map(snapshot.docs.map((order) => ({ id: order.id, ...order.data() })).map((order) => [order.id, order]));
    const newOrders = [...updatedOrders.values()].filter((order) =>
      order.status === "new" && !previousOrderIds.has(order.id));
    if (!firstOrderSnapshot && newOrders.length) {
      orderAlert.textContent = `${newOrders.length} new order${newOrders.length === 1 ? "" : "s"} just arrived`;
      playNewOrderSound();
    } else if (firstOrderSnapshot && updatedOrders.size === 0) {
      orderAlert.textContent = "Waiting for the first order";
    }
    previousOrderIds = new Set(updatedOrders.keys());
    firstOrderSnapshot = false;
    ordersById = updatedOrders;
    renderOrders();
    renderTables();
  }, (error) => {
    console.error("Live order listener failed:", error);
    const errorCode = String(error?.code || "").toLowerCase();
    const errorDetails = [error?.code, error?.message]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" — ");
    const cause = errorCode.includes("permission-denied")
      ? "Realtime Database denied this account. Verify the signed-in Google email and its active supervisorAccess record."
      : errorCode.includes("network") || errorCode.includes("disconnected")
        ? "The Realtime Database connection is unavailable. Check the network and database URL."
        : "Check the Firebase error details and the configured Realtime Database.";
    ordersMessage.textContent = [
      "Orders could not be loaded.",
      errorDetails && `Firebase error: ${errorDetails}.`,
      cause,
    ].filter(Boolean).join(" ");
  });
}

function startTablesListener() {
  tablesUnsubscribe = onSnapshot(collection(services.db, "tables"), (snapshot) => {
    tables = snapshot.docs.map((table) => ({
      id: table.id,
      ...table.data(),
      displayNumber: Number(table.get("displayNumber")),
    })).filter((table) => Number.isInteger(table.displayNumber));
    renderTables();
    renderQrCodes([...tables].sort((a, b) => a.displayNumber - b.displayNumber));
  }, (error) => {
    console.error("Table listener failed:", error);
    tableMessage.textContent = "Tables could not be loaded.";
  });
}

async function loadSupervisorAccess() {
  const result = await getDocs(collection(services.db, "supervisorAccess"));
  supervisorList.replaceChildren();
  for (const supervisorSnapshot of result.docs) {
    const supervisor = supervisorSnapshot.data();
    const row = document.createElement("tr");
    const email = document.createElement("td");
    email.textContent = supervisor.email;
    const roleCell = document.createElement("td");
    roleCell.textContent = supervisor.role === "manager" ? "Manager" : "Supervisor";
    const state = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = supervisor.status === "active" ? "table-state state-available" : "table-state state-inactive";
    badge.textContent = supervisor.status === "active" ? "Active" : "Revoked";
    state.append(badge);
    const action = document.createElement("td");
    if (supervisor.status === "active") {
      const revoke = document.createElement("button");
      revoke.className = "danger-button";
      revoke.type = "button";
      revoke.textContent = "Revoke access";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await callable("manageSupervisorAccess", {
            action: "revoke",
            email: supervisor.email,
          });
          supervisorMessage.textContent = "Supervisor access revoked.";
          await loadSupervisorAccess();
        } catch (error) {
          supervisorMessage.textContent = readableError(error, "Supervisor access could not be revoked.");
        } finally {
          revoke.disabled = false;
        }
      });
      action.append(revoke);
    }
    row.append(email, roleCell, state, action);
    supervisorList.append(row);
  }
}

async function loadMenuManager() {
  try {
    const result = await getDocs(collection(services.db, "menuItems"));
    menuItems = result.docs.map((item) => ({ id: item.id, ...item.data() }));
    menuList.replaceChildren();
    for (const item of menuItems) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = item.name;
      const category = document.createElement("td");
      category.textContent = item.category;
      const price = document.createElement("td");
      price.textContent = money(item.pricePaise);
      const availability = document.createElement("td");
      availability.textContent = item.available ? "Available" : "Sold out";
      const actions = document.createElement("td");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "quiet-button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => populateMenuForm(item));
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "quiet-button";
      toggle.textContent = item.available ? "Mark sold out" : "Make available";
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await updateDoc(doc(services.db, "menuItems", item.id), {
            available: !item.available,
            updatedAt: serverTimestamp(),
          });
          await loadMenuManager();
        } catch (error) {
          menuMessage.textContent = readableError(error, "Availability could not be updated.");
        } finally {
          toggle.disabled = false;
        }
      });
      actions.append(edit, toggle);
      row.append(name, category, price, availability, actions);
      menuList.append(row);
    }
  } catch (error) {
    console.error("Menu manager failed:", error);
    menuMessage.textContent = readableError(error, "Menu items could not be loaded.");
  }
}

function populateMenuForm(item) {
  editingMenuItemId = item.id;
  document.querySelector("#menu-name").value = item.name;
  document.querySelector("#menu-category").value = item.category;
  document.querySelector("#menu-price").value = (item.pricePaise / 100).toFixed(2);
  document.querySelector("#menu-vegetarian").value = String(item.isVegetarian === true);
  document.querySelector("#menu-description").value = item.description;
  document.querySelector("#menu-image").value = item.imageUrl;
  document.querySelector("#save-menu-button").textContent = "Save changes";
  document.querySelector("#menu-name").focus();
}

async function renderDashboard(user) {
  if (!user.email || !user.emailVerified) {
    throw new Error("Sign in with a Google account that has a verified email.");
  }
  const email = user.email.trim().toLowerCase();
  if (email === "kathipavankumarreddy@gmail.com") {
    role = "admin";
  } else {
    const roleResult = await callable("getStaffRole");
    role = roleResult.data.role;
  }
  if (!["admin", "manager", "supervisor"].includes(role)) throw new Error("Staff role unavailable.");
  const requestedPortal = new URLSearchParams(window.location.search).get("portal");
  const isCorrectPortal = requestedPortal === "admin"
    ? role === "admin"
    : requestedPortal === "supervisor"
      ? role === "supervisor" || role === "manager"
      : true;
  if (!isCorrectPortal) {
    const portalUrl = new URL(
      role === "admin" ? "admin-portal.html" : "supervisor-portal.html",
      window.location.href,
    );
    window.location.replace(portalUrl.href);
    return false;
  }
  currentUser = user;
  loginScreen.hidden = true;
  dashboard.hidden = false;
  const roleTitle = role === "admin" ? "Admin" : role === "manager" ? "Manager" : "Supervisor";
  document.title = `${roleTitle} Dashboard | Olive & Ember`;
  document.querySelector("#sidebar-name").textContent = user.displayName || user.email || "Staff";
  document.querySelector("#sidebar-role").textContent = roleTitle;
  document.querySelector("#user-avatar").textContent = (user.displayName || user.email || "O").slice(0, 1).toUpperCase();
  document.querySelector("#profile-avatar").textContent = (user.displayName || user.email || "O").slice(0, 1).toUpperCase();
  document.querySelector("#profile-name").textContent = user.displayName || "Staff member";
  document.querySelector("#profile-email").textContent = user.email || "";
  document.querySelector("#profile-role").textContent = roleTitle;
  document.querySelector("#workspace-date").textContent = new Intl.DateTimeFormat("en-IN", {
    weekday: "short", day: "numeric", month: "short",
  }).format(new Date());
  document.querySelectorAll(".admin-only").forEach((section) => {
    section.hidden = role !== "admin";
  });
  document.querySelectorAll(".manager-access").forEach((section) => {
    section.hidden = role !== "admin" && role !== "manager";
  });
  renderNavigation();
  setView("overview");
  startOrdersListener();
  startTablesListener();

  if (role === "admin" || role === "manager") {
    await loadMenuManager();
  }
  if (role === "admin") {
    await loadSupervisorAccess();
    supervisorsUnsubscribe = onSnapshot(
      collection(services.db, "supervisorAccess"),
      () => loadSupervisorAccess().catch((error) => {
        supervisorMessage.textContent = readableError(error, "Access records could not be refreshed.");
      }),
      (error) => {
        console.error("Supervisor access listener failed:", error);
        supervisorMessage.textContent = "Supervisor access changes could not be monitored.";
      },
    );
  }
  if (role === "admin" || role === "manager") startVisitListener();
  handledUid = user.uid;
}

function addAdminVisitMetric(value) {
  dailyVisits = String(value);
  renderAdminMetrics();
}

async function handleSupervisorSubmit(event) {
  event.preventDefault();
  const input = document.querySelector("#supervisor-email");
  const staffRole = document.querySelector("#staff-role").value;
  const button = document.querySelector("#add-supervisor-button");
  button.disabled = true;
  supervisorMessage.textContent = `Granting ${staffRole} access…`;
  try {
    const email = input.value.trim().toLowerCase();
    if (!/^[a-z0-9._+-]+@gmail\.com$/.test(email)) {
      throw new Error("Enter a valid Gmail address.");
    }
    if (!["supervisor", "manager"].includes(staffRole)) {
      throw new Error("Choose a valid staff role.");
    }
    await callable("manageSupervisorAccess", {
      action: "add",
      email,
      role: staffRole,
    });
    supervisorMessage.textContent = `${staffRole === "manager" ? "Manager" : "Supervisor"} access granted successfully.`;
    input.value = "";
    await loadSupervisorAccess();
  } catch (error) {
    supervisorMessage.textContent = readableError(error, "Could not authorize this supervisor.");
  } finally {
    button.disabled = false;
  }
}

async function handleMenuSubmit(event) {
  event.preventDefault();
  const button = document.querySelector("#save-menu-button");
  button.disabled = true;
  menuMessage.textContent = "Saving menu item…";
  const item = {
    name: document.querySelector("#menu-name").value.trim(),
    category: document.querySelector("#menu-category").value,
    pricePaise: Math.round(Number(document.querySelector("#menu-price").value) * 100),
    isVegetarian: document.querySelector("#menu-vegetarian").value === "true",
    description: document.querySelector("#menu-description").value.trim(),
    imageUrl: document.querySelector("#menu-image").value.trim(),
  };
  try {
    const itemId = editingMenuItemId || `${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${createUuid().slice(0, 8)}`;
    const itemRef = doc(services.db, "menuItems", itemId);
    if (editingMenuItemId) {
      await updateDoc(itemRef, { ...item, updatedAt: serverTimestamp() });
    } else {
      await setDoc(itemRef, { ...item, currency: "INR", available: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
    menuMessage.textContent = editingMenuItemId ? "Menu item updated." : "Menu item added.";
    editingMenuItemId = null;
    menuForm.reset();
    button.textContent = "Add menu item";
    await loadMenuManager();
  } catch (error) {
    menuMessage.textContent = readableError(error, "Menu item could not be saved.");
  } finally {
    button.disabled = false;
  }
}

async function addTable() {
  const button = document.querySelector("#add-table-button");
  button.disabled = true;
  tableMessage.textContent = "Adding table…";
  try {
    const snapshot = await getDocs(collection(services.db, "tables"));
    const numbers = snapshot.docs.map((table) => Number(table.get("displayNumber"))).filter(Number.isInteger);
    const displayNumber = Math.max(0, ...numbers) + 1;
    const tableId = `table-${String(displayNumber).padStart(2, "0")}`;
    const created = await createDocIfAbsent(doc(services.db, "tables", tableId), {
      displayNumber,
      active: true,
      createdAt: serverTimestamp(),
    });
    if (!created) throw new Error("Another table was added at the same time. Refresh and retry.");
    tableMessage.textContent = `Table ${displayNumber} added. Its QR code is ready.`;
  } catch (error) {
    tableMessage.textContent = readableError(error, "Table could not be added.");
  } finally {
    button.disabled = false;
  }
}

async function verifySignedInUser(user) {
  if (handledUid === user.uid || verifyingRole) return;
  verifyingRole = true;
  staffMessage.textContent = "Verifying your staff access…";
  signInButton.disabled = true;
  try {
    const dashboardReady = await renderDashboard(user);
    if (dashboardReady === false) return;
    if (role === "supervisor" || role === "manager") {
      usersUnsubscribe = onSnapshot(doc(services.db, "supervisorAccess", user.email.trim().toLowerCase()), (snapshot) => {
        if (
          !snapshot.exists()
          || snapshot.data().status !== "active"
          || (snapshot.data().role || "supervisor") !== role
        ) accessDenied();
      }, (error) => {
        console.error("Could not monitor supervisor authorization:", error);
        if (error.code === "permission-denied") {
          accessDenied();
        } else {
          orderAlert.textContent = "Staff access changes could not be checked because the connection is unavailable.";
        }
      });
    }
  } catch (error) {
    console.error("Staff access verification failed:", {
      code: typeof error?.code === "string" ? error.code : "unknown",
      message: typeof error?.message === "string" ? error.message : "No error message",
    });
    const errorCode = String(error?.code || "").toLowerCase();
    const accessDenied = errorCode === "functions/permission-denied"
      || errorCode === "permission-denied"
      || errorCode === "functions/unauthenticated"
      || error.message === "Sign in with a Google account that has a verified email.";
    const message = accessDenied
      ? "Access denied. Sign in with a verified Google account authorized for this staff portal."
      : errorCode === "functions/unavailable"
        || errorCode === "unavailable"
        || errorCode === "functions/deadline-exceeded"
        ? "The staff authorization backend is unavailable. Start the Functions emulator, then select Retry staff access."
        : errorCode === "functions/internal"
          ? `${readableError(error, "The staff authorization backend failed.")} (functions/internal). Check the Functions and Realtime Database emulator logs, then select Retry staff access.`
          : readableError(error, "Staff access could not be verified. Check the Firebase connection and backend logs.");
    signInErrorMessage = message;
    showLogin(message);

    signInButton.textContent = accessDenied ? "Continue with Google" : "Retry staff access";
    if (accessDenied) {
      await signOut(services.auth);
    }
  } finally {
    verifyingRole = false;
    signInButton.disabled = false;
  }
}

signInButton.addEventListener("click", async () => {
  if (services.auth.currentUser) {
    await verifySignedInUser(services.auth.currentUser);
    return;
  }
  signInErrorMessage = "";
  signInButton.disabled = true;
  staffMessage.textContent = "Connecting to Google…";
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(services.auth, provider);
  } catch (error) {
    console.error("Google sign-in failed:", error);
    signInErrorMessage = formatSignInError(error);
    staffMessage.textContent = signInErrorMessage;
    signInButton.disabled = false;
  }
});

signOutButton.addEventListener("click", () => signOut(services.auth));
supervisorForm.addEventListener("submit", handleSupervisorSubmit);
menuForm.addEventListener("submit", handleMenuSubmit);
document.querySelector("#add-table-button").addEventListener("click", addTable);
document.querySelector("#print-all-qrs").addEventListener("click", () => window.print());
filterSelect.addEventListener("change", renderOrders);
historySearch.addEventListener("input", renderOrders);
soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  soundToggle.setAttribute("aria-pressed", String(soundEnabled));
  soundToggle.textContent = soundEnabled ? "Order sound on" : "Enable order sound";
  orderAlert.textContent = soundEnabled ? "New-order sound enabled" : "Sound disabled — visual alerts remain on";
  if (soundEnabled) playNewOrderSound();
});
document.querySelectorAll("[data-go-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.goView));
});
document.querySelector("#live-order-filter").addEventListener("change", renderOrders);

async function initialize() {
  try {
    services = getFirebaseServices("staff");
    onAuthStateChanged(services.auth, async (user) => {
      if (!user) {
        if (!signingOutForRevocation) {
          showLogin(signInErrorMessage || "You are not signed in yet. Select “Continue with Google” and choose the configured Admin account: kathipavankumarreddy@gmail.com.");
        }
        return;
      }
      signInErrorMessage = "";
      if (handledUid && handledUid !== user.uid) {
        showLogin("Verifying your staff access…");
      }
      await verifySignedInUser(user);
    });
  } catch (error) {
    console.error("Staff portal could not start:", error);
    staffMessage.textContent = readableError(error, "Staff sign-in is unavailable.");
    signInButton.disabled = true;
  }
}

function startVisitListener() {
  if (role !== "admin" && role !== "manager") return;
  const todayQuery = query(
    collection(services.db, "visits"),
    where("createdAt", ">=", Timestamp.fromDate(dayStart())),
  );
  visitsUnsubscribe = onSnapshot(todayQuery, (snapshot) => {
    addAdminVisitMetric(snapshot.size);
  }, (error) => {
    console.error("Visit report listener failed:", error);
    addAdminVisitMetric("Unavailable");
  });
}

initialize();
