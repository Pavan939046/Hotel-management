import {
  browserLocalPersistence,
  setPersistence,
  signInAnonymously,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "./rtdb-compat.js";
import { getFirebaseServices } from "./firebase-client.js";
import { createUuid } from "./secure-uuid.js";

const menuGrid = document.querySelector("#menu-grid");
const categoryList = document.querySelector("#category-list");
const searchInput = document.querySelector("#search-input");
const resultsSummary = document.querySelector("#results-summary");
const emptyState = document.querySelector("#empty-state");
const tableLabel = document.querySelector("#table-label");
const welcomeTable = document.querySelector("#welcome-table");
const menuMessage = document.querySelector("#menu-message");
const cartToggle = document.querySelector("#cart-toggle");
const cartDrawer = document.querySelector("#cart-drawer");
const cartClose = document.querySelector("#cart-close");
const cartCount = document.querySelector("#cart-count");
const cartItemsElement = document.querySelector("#cart-items");
const cartTotal = document.querySelector("#cart-total");
const instructionsInput = document.querySelector("#special-instructions");
const placeOrderButton = document.querySelector("#place-order");
const cartMessage = document.querySelector("#cart-message");
const orderStatusPanel = document.querySelector("#order-status");

const tableParameter = new URLSearchParams(window.location.search).get("table");
const tableNumber = Number(tableParameter);
const validTable = Number.isInteger(tableNumber) && tableNumber >= 1 && tableNumber <= 11;
const orderIdFromUrl = new URLSearchParams(window.location.search).get("order");
const menuItems = [];
const cart = new Map();
let selectedCategory = "All";
let services;
let customer;
let orderListener;
let orderInProgress = false;
let pendingSubmission;
let tableIsActive = false;
const trustedOrderBackendEnabled = import.meta.env.VITE_TRUSTED_ORDER_BACKEND_ENABLED === "true";

function formatPrice(paise) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(paise / 100);
}

function readableError(error, fallback) {
  const message = typeof error?.message === "string" ? error.message : "";
  return message && !/^(internal|unknown)(\s|$)/i.test(message) && !message.includes("[0]")
    ? message
    : fallback;
}

function getCategories() {
  return ["All", ...new Set(menuItems.map((item) => item.category))];
}

function renderCategories() {
  categoryList.replaceChildren();
  for (const category of getCategories()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-button";
    button.textContent = category;
    button.setAttribute("aria-pressed", String(category === selectedCategory));
    button.addEventListener("click", () => {
      selectedCategory = category;
      renderCategories();
      renderMenu();
    });
    categoryList.append(button);
  }
}

function renderMenu() {
  const searchTerm = searchInput.value.trim().toLocaleLowerCase();
  const filteredItems = menuItems.filter((item) => {
    const matchesCategory = selectedCategory === "All" || item.category === selectedCategory;
    const searchableText = `${item.name} ${item.description} ${item.category}`.toLocaleLowerCase();
    return matchesCategory && searchableText.includes(searchTerm);
  });

  resultsSummary.textContent = `${filteredItems.length} ${
    filteredItems.length === 1 ? "dish" : "dishes"
  }`;
  emptyState.hidden = filteredItems.length > 0;
  menuGrid.hidden = filteredItems.length === 0 || orderStatusPanel.hidden === false;
  menuGrid.replaceChildren();

  for (const item of filteredItems) {
    const card = document.createElement("article");
    card.className = "menu-card";

    const imageWrap = document.createElement("div");
    imageWrap.className = "food-image-wrap";
    const image = document.createElement("img");
    image.className = "food-image";
    image.src = item.image;
    image.alt = item.imageAlt;
    image.loading = "lazy";
    imageWrap.append(image);

    const availability = document.createElement("span");
    availability.className = `availability${item.available ? "" : " unavailable"}`;
    availability.textContent = item.available ? "Available" : "Currently unavailable";
    imageWrap.append(availability);

    const details = document.createElement("div");
    details.className = "food-details";
    const meta = document.createElement("div");
    meta.className = "food-meta";
    const category = document.createElement("span");
    category.textContent = item.category;
    const dietary = document.createElement("span");
    dietary.className = `dietary-badge ${item.isVegetarian ? "vegetarian" : "non-vegetarian"}`;
    dietary.textContent = item.isVegetarian ? "Vegetarian" : "Non-vegetarian";
    meta.append(category, dietary);

    const name = document.createElement("h3");
    name.className = "food-name";
    name.textContent = item.name;
    const description = document.createElement("p");
    description.className = "food-description";
    description.textContent = item.description;

    const bottom = document.createElement("div");
    bottom.className = "food-bottom";
    const price = document.createElement("span");
    price.className = "food-price";
    price.textContent = formatPrice(item.pricePaise);
    const addButton = document.createElement("button");
    addButton.className = "add-button";
    addButton.type = "button";
    const selectedQuantity = quantityFor(item.id);
    addButton.textContent = item.available
      ? selectedQuantity >= 20 ? "Maximum quantity reached" : selectedQuantity ? `Add more · ${selectedQuantity} in bag` : "Add to bag"
      : "Sold out";
    addButton.disabled = !item.available || !tableIsActive || Boolean(pendingSubmission) || selectedQuantity >= 20;
    addButton.setAttribute(
      "aria-label",
      item.available ? `Add ${item.name}` : `${item.name} is unavailable`,
    );
    addButton.addEventListener("click", () => {
      cart.set(item.id, (cart.get(item.id) || 0) + 1);
      renderCart();
      renderMenu();
      cartDrawer.hidden = false;
    });
    bottom.append(price, addButton);
    details.append(meta, name, description, bottom);
    card.append(imageWrap, details);
    menuGrid.append(card);
  }
}

function renderCart() {
  const itemCount = [...cart.values()].reduce((sum, quantity) => sum + quantity, 0);
  cartCount.textContent = String(itemCount);
  cartToggle.hidden = !validTable || itemCount === 0 || Boolean(pendingSubmission) || !tableIsActive;
  document.querySelector("#empty-cart").hidden = itemCount !== 0;
  cartItemsElement.replaceChildren();
  let subtotalPaise = 0;

  for (const [itemId, quantity] of cart) {
    const item = menuItems.find((menuItem) => menuItem.id === itemId);
    if (!item) continue;
    subtotalPaise += item.pricePaise * quantity;
    const row = document.createElement("div");
    row.className = "cart-item";
    const image = document.createElement("img");
    image.className = "cart-item-image";
    image.src = item.image;
    image.alt = "";
    image.loading = "lazy";
    const itemName = document.createElement("div");
    itemName.className = "cart-item-name";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const lineTotal = document.createElement("span");
    lineTotal.textContent = formatPrice(item.pricePaise * quantity);
    itemName.append(name, lineTotal);

    const controls = document.createElement("div");
    controls.className = "quantity-control";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", `Remove one ${item.name}`);
    minus.disabled = Boolean(pendingSubmission);
    minus.addEventListener("click", () => {
      const nextQuantity = (cart.get(itemId) || 0) - 1;
      if (nextQuantity <= 0) cart.delete(itemId);
      else cart.set(itemId, nextQuantity);
      renderCart();
      renderMenu();
    });
    const quantityLabel = document.createElement("span");
    quantityLabel.textContent = String(quantityFor(itemId));
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", `Add one ${item.name}`);
    plus.disabled = Boolean(pendingSubmission) || quantityFor(itemId) >= 20;
    plus.addEventListener("click", () => {
      cart.set(itemId, (cart.get(itemId) || 0) + 1);
      renderCart();
      renderMenu();
    });
    const remove = document.createElement("button");
    remove.className = "remove-item";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${item.name} from your bag`);
    remove.disabled = Boolean(pendingSubmission);
    remove.addEventListener("click", () => {
      cart.delete(itemId);
      renderCart();
      renderMenu();
    });
    controls.append(minus, quantityLabel, plus);
    row.append(image, itemName, controls, remove);
    cartItemsElement.append(row);
  }

  const taxPaise = Math.round(subtotalPaise * 0.05);
  const hasUnavailableItem = [...cart.keys()].some((itemId) =>
    !menuItems.some((menuItem) => menuItem.id === itemId && menuItem.available));
  cartTotal.textContent = `Subtotal ${formatPrice(subtotalPaise)} · GST (5%) ${formatPrice(
    taxPaise,
  )} · Estimated total ${formatPrice(subtotalPaise + taxPaise)}`;
  placeOrderButton.disabled = itemCount === 0 || orderInProgress || !tableIsActive || hasUnavailableItem
    || !trustedOrderBackendEnabled;
  if (!trustedOrderBackendEnabled && itemCount > 0) {
    cartMessage.textContent = "Your bag and bill preview are working. Orders cannot be sent until the secure backend is deployed. Please ask staff to place this order.";
  }
  if (hasUnavailableItem) cartMessage.textContent = "A selected dish is no longer available. Remove it before placing your order.";
  else if (cartMessage.textContent.startsWith("A selected dish is no longer available.")) cartMessage.textContent = "";
  placeOrderButton.textContent = pendingSubmission
    ? "Retry order safely"
    : trustedOrderBackendEnabled ? "Place order" : "Ordering unavailable";
}

function quantityFor(itemId) {
  return cart.get(itemId) || 0;
}

function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch (error) {
    console.error("Could not read this browser session:", error);
    return null;
  }
}

function writeSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch (error) {
    throw new Error("This browser cannot save the order session. Enable browser session storage and retry.");
  }
}

function orderSessionKey() {
  return `olive-ember-order-table-${tableNumber}`;
}

function setOrderUrl(orderId) {
  const url = new URL(window.location.href);
  if (orderId) url.searchParams.set("order", orderId);
  else url.searchParams.delete("order");
  url.searchParams.delete("request");
  window.history.replaceState(null, "", url);
}

function setRequestUrl(requestId) {
  const url = new URL(window.location.href);
  url.searchParams.set("request", requestId);
  url.searchParams.delete("order");
  window.history.replaceState(null, "", url);
}

function statusText(status) {
  return {
    new: "Order received",
    accepted: "Order accepted",
    preparing: "Your food is being prepared",
    ready: "Your order is ready",
    delivered: "Delivered",
    completed: "Delivered",
    rejected: "This order was rejected. Please contact restaurant staff.",
  }[status] || "Status unavailable";
}

function renderOrder(order) {
  orderStatusPanel.replaceChildren();
  orderStatusPanel.hidden = false;
  cartDrawer.hidden = true;
  cartToggle.hidden = true;
  menuGrid.hidden = true;

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  const isDelivered = ["delivered", "completed"].includes(order.status);
  eyebrow.textContent = isDelivered ? "ORDER DELIVERED" : "LIVE ORDER STATUS";
  const heading = document.createElement("h2");
  heading.textContent = isDelivered
    ? "Your order has been delivered"
    : statusText(order.status);
  const message = document.createElement("p");
  message.textContent = isDelivered
    ? "Thank you for dining with us! We hope to see you again."
    : `Table ${order.tableNumber} · ${statusText(order.status)}`;
  const id = document.createElement("p");
  id.className = "order-id";
  id.textContent = `Order ${order.id}`;
  const total = document.createElement("p");
  const subtotalPaise = (order.items || []).reduce(
    (sum, item) => sum + item.pricePaise * item.quantity,
    0,
  );
  const totalPaise = subtotalPaise + Math.round(subtotalPaise * 0.05);
  total.textContent = `Order total including 5% GST: ${formatPrice(totalPaise)}`;
  orderStatusPanel.append(eyebrow, heading, message, id, total);

  if (order.status === "rejected") {
    const dismissButton = document.createElement("button");
    dismissButton.className = "text-button";
    dismissButton.type = "button";
    dismissButton.textContent = "Return to menu";
    dismissButton.addEventListener("click", dismissOrder);
    orderStatusPanel.append(dismissButton);
  }
}

function dismissOrder() {
  orderListener?.();
  orderListener = undefined;
  writeSession(orderSessionKey(), null);
  setOrderUrl(null);
  orderStatusPanel.hidden = true;
  menuMessage.hidden = true;
  menuGrid.hidden = false;
  cart.clear();
  renderMenu();
  renderCart();
}

function listenForOrder(orderId) {
  orderListener?.();
  orderListener = onSnapshot(
    doc(services.db, "orders", orderId),
    (snapshot) => {
      if (!snapshot.exists()) {
        cartMessage.textContent = "This order is not available in the current customer session.";
        return;
      }
      renderOrder({ id: snapshot.id, ...snapshot.data() });
    },
    (error) => {
      console.error("Order status listener failed:", error);
      cartMessage.textContent = "Order status could not be loaded. Refresh the page or ask staff for help.";
    },
  );
}

async function submitSavedOrder(payload) {
  orderInProgress = true;
  placeOrderButton.disabled = true;
  cartMessage.textContent = "Sending your order securely…";
  try {
    const result = await httpsCallable(services.functions, "createOrder")(payload);
    writeSession(orderSessionKey(), result.data.orderId);
    setOrderUrl(result.data.orderId);
    writeSession("olive-ember-pending-order", null);
    pendingSubmission = null;
    cart.clear();
    instructionsInput.value = "";
    renderCart();
    cartMessage.textContent = result.data.duplicate
      ? "Your existing order was restored; it was not submitted twice."
      : "Order placed successfully.";
    listenForOrder(result.data.orderId);
  } catch (error) {
    console.error("Order submission failed:", error);
    cartMessage.textContent = `${readableError(error, "The order service is temporarily unavailable.")} Retry safely or ask staff for help.`;
  } finally {
    orderInProgress = false;
    renderCart();
  }
}

async function placeOrder() {
  if (orderInProgress || !validTable || !customer || cart.size === 0) return;
  if (!trustedOrderBackendEnabled) {
    cartMessage.textContent = "Ordering is currently unavailable. The trusted Realtime Database order backend must be deployed first.";
    return;
  }
  if (pendingSubmission) {
    await submitSavedOrder(pendingSubmission);
    return;
  }
  const payload = {
    tableNumber,
    requestId: createUuid(),
    items: [...cart].map(([itemId, quantity]) => ({ itemId, quantity })),
    instructions: instructionsInput.value.trim(),
  };
  try {
    writeSession("olive-ember-pending-order", JSON.stringify(payload));
    setRequestUrl(payload.requestId);
    pendingSubmission = payload;
  } catch (error) {
    cartMessage.textContent = error.message;
    return;
  }
  renderCart();
  await submitSavedOrder(payload);
}

async function restoreExistingOrder() {
  if (orderIdFromUrl) {
    if (!/^[A-Za-z0-9_-]{20}$/.test(orderIdFromUrl)) {
      throw new Error("This order link is invalid.");
    }
    writeSession(orderSessionKey(), orderIdFromUrl);
    listenForOrder(orderIdFromUrl);
    return;
  }

  writeSession(orderSessionKey(), null);
  const requestIdFromUrl = new URLSearchParams(window.location.search).get("request");
  const pendingRaw = requestIdFromUrl
    ? readSession("olive-ember-pending-order")
    : null;
  if (!requestIdFromUrl) writeSession("olive-ember-pending-order", null);

  if (!pendingRaw) return;
  try {
    const payload = JSON.parse(pendingRaw);
    if (
      payload.tableNumber !== tableNumber
      || payload.requestId !== requestIdFromUrl
      || !Array.isArray(payload.items)
    ) {
      throw new Error("The saved order request is invalid.");
    }
    pendingSubmission = payload;
    cart.clear();
    for (const item of payload.items) cart.set(item.itemId, item.quantity);
    instructionsInput.value = payload.instructions || "";
    renderCart();
    cartMessage.textContent = "Checking for an order already submitted…";
    const result = await httpsCallable(services.functions, "getOrderRequest")({ requestId: payload.requestId });
    if (result.data.orderId) {
      writeSession(orderSessionKey(), result.data.orderId);
      setOrderUrl(result.data.orderId);
      writeSession("olive-ember-pending-order", null);
      pendingSubmission = null;
      cart.clear();
      renderCart();
      listenForOrder(result.data.orderId);
    } else {
      cartDrawer.hidden = false;
      cartMessage.textContent = "The previous request was not found. Retry safely to submit that same order.";
    }
  } catch (error) {
    console.error("Could not restore the previous order:", error);
    menuMessage.textContent = "The previous order could not be restored. Please ask restaurant staff for help.";
  }
}

function showMenuError(message) {
  menuMessage.textContent = message;
  menuMessage.hidden = false;
  menuGrid.hidden = true;
  categoryList.hidden = true;
}

async function startCustomerApp() {
  tableLabel.textContent = validTable
    ? `Welcome — Table ${tableNumber}`
    : tableParameter === null ? "Browse menu" : "Invalid table";
  welcomeTable.textContent = validTable
    ? `Table ${tableNumber}`
    : tableParameter === null ? "browse our menu" : "invalid table link";

  try {
    services = getFirebaseServices();
    await setPersistence(services.auth, browserLocalPersistence);
    if (!services.auth.currentUser) {
      await signInAnonymously(services.auth);
    }
    customer = services.auth.currentUser;
    if (!customer) throw new Error("Could not start a customer session. Refresh the page and retry.");

    if (validTable) {
      const tableDocumentId = `table-${String(tableNumber).padStart(2, "0")}`;
      onSnapshot(
        doc(services.db, "tables", tableDocumentId),
        (snapshot) => {
          tableIsActive = snapshot.exists() && snapshot.get("active") === true;
          if (!tableIsActive) {
            menuMessage.textContent = "This table is currently unavailable. Please ask a team member for help.";
            menuMessage.hidden = false;
          } else if (menuItems.length) {
            menuMessage.hidden = true;
          }
          renderMenu();
          renderCart();
        },
        (error) => {
          console.error("Table availability listener failed:", error);
          tableIsActive = false;
          menuMessage.textContent = "Table availability could not be verified. Please ask a team member for help.";
          menuMessage.hidden = false;
          renderCart();
        },
      );
    }

    if (trustedOrderBackendEnabled && validTable) {
      let visitId = readSession("olive-ember-visit-id");
      if (!visitId) {
        visitId = createUuid();
        writeSession("olive-ember-visit-id", visitId);
      }
      httpsCallable(services.functions, "logVisit")({ tableNumber, visitId }).catch((error) => {
        console.error("Visit could not be recorded:", error);
      });
    }
    onSnapshot(
      collection(services.db, "menuItems"),
      (snapshot) => {
        menuItems.splice(
          0,
          menuItems.length,
          ...snapshot.docs.map((itemDoc) => {
            const item = itemDoc.data();
            return {
              id: itemDoc.id,
              name: item.name,
              category: item.category,
              description: item.description,
              pricePaise: item.pricePaise,
              available: item.available === true,
              image: item.imageUrl,
              imageAlt: item.name,
              isVegetarian: item.isVegetarian === true,
            };
          }),
        );
        menuMessage.hidden = validTable && menuItems.length > 0 && tableIsActive;
        menuMessage.textContent = !validTable
          ? tableParameter === null
            ? "Scan a table QR code to place an order."
            : "This table link is invalid. Scan the QR code placed on your table."
          : !tableIsActive
            ? "This table is currently unavailable. Please ask a team member for help."
            : menuItems.length ? "" : "The menu is empty. Ask staff to add dishes.";
        categoryList.hidden = false;
        emptyState.hidden = true;
        renderCategories();
        renderMenu();
        renderCart();
      },
      (error) => {
        console.error("Menu listener failed:", error);
        showMenuError("The live menu could not be loaded. Check your connection or ask restaurant staff.");
      },
    );
    await restoreExistingOrder();
  } catch (error) {
    console.error("Customer menu startup failed:", error);
    showMenuError(readableError(error, "Could not connect to the restaurant ordering service. Check the connection and try again."));
  }
}

tableLabel.textContent = validTable ? `Welcome — Table ${tableNumber}` : "Menu";
welcomeTable.textContent = validTable ? `Table ${tableNumber}` : "your table is ready";
menuGrid.hidden = true;
menuMessage.hidden = false;
renderCategories();
searchInput.addEventListener("input", renderMenu);
cartToggle.addEventListener("click", () => {
  cartDrawer.hidden = false;
  instructionsInput.focus();
});
cartClose.addEventListener("click", () => {
  cartDrawer.hidden = true;
});
placeOrderButton.addEventListener("click", placeOrder);
startCustomerApp();

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  }
});
