const WebSocket = require("ws");
const axios = require("axios");

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  apiUrl: "https://api.hyperliquid.xyz/info",
  wsUrl: "wss://api.hyperliquid.xyz/ws",

  // --- Настройки Telegram ---
  telegram: {
    enabled: true, // Включить/выключить отправку
    botToken: "8222776620:AAHPqgNOk8ZPEAI03ZBfxy0tDtGXoxJDaGE", // Токен от @BotFather
    chatId: "-1003610905611", // ID канала (например, -100123456789 или @my_channel_name)
  },

  // --- Пороги объема в USD ---
  defaultThresholdUSD: 500000, // 0.5 млн $
  customThresholdsUSD: {
    BTC: 30000000, // 30 млн $
    ETH: 20000000, // 20 млн $
    SOL: 15000000, // 3 млн $
    XRP: 10000000, // 10 млн $
    HYPE: 5000000, // 5 млн $
    kPEPE: 1000000, // 1 млн $
    DOGE: 1000000, // 1 млн $
    PAXG: 10000000, // 10 млн $
    BNB: 10000000, // 10 млн $
    SEI: 5000000, // 5 млн $
    ZEC: 1000000, // 1 млн $
    LTC: 2000000, // 2 млн $
    AAVE: 1000000, // 1 млн $
    NEAR: 1000000, // 1 млн $
    ASTER: 2000000, // 2 млн $
    MAVIA: 900000, // 0.9 млн $
    SUI: 2000000, // 2 млн $
    RESOLV: 400000, // 0.4 млн $
  },

  // --- Оптимизация спама ---
  maxDistancePercent: 3,
  alertCooldownMs: 300000,
  maxLevelsToScan: 100,

  // --- Технические настройки ---
  MAX_SUBS_PER_SOCKET: 80,
  SUB_DELAY_MS: 100,
  RECONNECT_DELAY: 5000,
};

// Хранилище для кулдауна уведомлений
const alertCache = new Map();

// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

// https://hypurrscan.io/
// async function getWalletsByPrice(coin, targetPrice) {
//   const url = `https://testapi.hypurrscan.io/markets/${coin}/orderbook`;

//   try {
//     // Axios автоматически парсит JSON и возвращает его в свойстве .data
//     const response = await axios.get(url);
//     const bookData = response.data;

//     // Проверяем наличие bids и asks, чтобы не возникло ошибки при склеивании
//     const bids = bookData.bids || [];
//     const asks = bookData.asks || [];

//     const allOrders = [...bids, ...asks];

//     // Фильтруем по цене и сортируем по объему (от большего к меньшему)
//     const biggestOrder = allOrders
//       .filter((order) => Number(order.price) === Number(targetPrice))
//       .sort((a, b) => Number(b.size) - Number(a.size))[0];

//     if (biggestOrder) {
//       console.log(`Крупнейший кошелек на цене ${targetPrice}: ${biggestOrder.user}`);
//       console.log(`Объем ордера: ${biggestOrder.size}`);
//       return biggestOrder;
//     } else {
//       console.log(`На цене ${targetPrice} ордеров не обнаружено.`);
//     }
//   } catch (error) {
//     // В Axios детали ошибки лежат в error.response
//     if (error.response) {
//       console.error(`Ошибка API (${error.response.status}):`, error.response.data);
//     } else {
//       console.error("Ошибка сети или запроса:", error.message);
//     }
//   }
// }

//https://hyperdash.com/
async function getWalletsByPrice(coin, targetPrice) {
  const url = "https://api.hyperdash.com/graphql";

  const data = {
    operationName: "GetOrderbookSnapshotFiltered",
    query: `query GetOrderbookSnapshotFiltered($market: String!, $minPrice: Float!, $maxPrice: Float!) {
    orderbookSnapshotFiltered(market: $market, minPrice: $minPrice, maxPrice: $maxPrice) {
      address
      order {
        coin
        side
        limitPx
        sz
      }
    }
  }`,
    variables: {
      market: coin,
      minPrice: Number(targetPrice),
      maxPrice: Number(targetPrice),
    },
  };

  try {
    // Axios автоматически парсит JSON и возвращает его в свойстве .data
    const response = await axios.post(url, data);

    const list = response.data?.data?.orderbookSnapshotFiltered;

    // Если массив пуст, выходим
    if (!list || list.length === 0) {
      console.log("Ордеров не найдено");
      return;
    }

    // Ищем объект с максимальным sz
    const biggestOrder = list.reduce((max, current) => {
      // Преобразуем строки в числа для корректного сравнения
      const currentSize = parseFloat(current.order.sz);
      const maxSize = parseFloat(max.order.sz);

      return currentSize > maxSize ? current : max;
    });

    // Сохраняем результат в переменную в нужном вам формате
    const result = {
      user: biggestOrder.address,
      size: parseFloat(biggestOrder.order.sz),
    };

    console.log(`Крупнейший кошелек на цене ${targetPrice}: ${result.user}`);
    console.log(`Объем ордера: ${result.size}`);

    return result;
  } catch (error) {
    // В Axios детали ошибки лежат в error.response
    if (error.response) {
      console.error(`Ошибка API (${error.response.status}):`, error.response.data);
    } else {
      console.error("Ошибка сети или запроса:", error.message);
    }
  }
}

/**
 * Отправка сообщения в Telegram
 */
async function sendTelegramAlert(message) {
  if (!CONFIG.telegram.enabled) return;

  const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CONFIG.telegram.chatId,
      text: message,
      parse_mode: "Markdown", // Позволяет использовать жирный шрифт
    });
  } catch (e) {
    console.error("❌ Ошибка отправки в Telegram:", e.response?.data?.description || e.message);
  }
}

/**
 * Проверка кулдауна уведомлений
 */
function shouldAlert(coin, side, price) {
  const key = `${coin}_${side}_${price}`;
  const now = Date.now();

  if (alertCache.has(key)) {
    const lastTime = alertCache.get(key);
    if (now - lastTime < CONFIG.alertCooldownMs) return false;
  }

  alertCache.set(key, now);

  if (alertCache.size > 2000) {
    for (let [k, v] of alertCache) {
      if (now - v > CONFIG.alertCooldownMs) alertCache.delete(k);
    }
  }
  return true;
}

/**
 * Получение всех фьючерсных тикеров
 */
async function getPerpTickers() {
  try {
    const res = await axios.post(CONFIG.apiUrl, { type: "meta" });
    const tickers = res.data.universe.map((u) => u.name);
    console.log(`✅ Метаданные загружены. Всего фьючерсов: ${tickers.length}`);
    return tickers;
  } catch (e) {
    console.error("❌ Ошибка API при получении метаданных:", e.message);
    process.exit(1);
  }
}

// ==========================================
// 3. ЛОГИКА ШАРДОВ И WEBSOCKET
// ==========================================

function createSocketShard(coins, shardId) {
  const ws = new WebSocket(CONFIG.wsUrl);
  let pingInterval;

  ws.on("open", async () => {
    console.log(`🌐 [Шард ${shardId}] Соединение открыто. Подписка на ${coins.length} монет...`);

    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: "ping" }));
      }
    }, 15000);

    for (const coin of coins) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            method: "subscribe",
            subscription: { type: "l2Book", coin: coin },
          }),
        );
        await new Promise((r) => setTimeout(r, CONFIG.SUB_DELAY_MS));
      }
    }
  });

  ws.on("message", async (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (e) {
      return;
    }

    if (message.channel === "pong") return;

    if (message.channel === "l2Book" && message.data) {
      const { coin, levels } = message.data;

      if (!levels || !levels[0] || !levels[1] || levels[0].length === 0 || levels[1].length === 0) {
        return;
      }

      const threshold = CONFIG.customThresholdsUSD[coin] || CONFIG.defaultThresholdUSD;

      const bestBid = parseFloat(levels[0][0].px);
      const bestAsk = parseFloat(levels[1][0].px);

      if (isNaN(bestBid) || isNaN(bestAsk)) return;

      const midPrice = (bestBid + bestAsk) / 2;

      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const sideName = sideIdx === 0 ? "BUY" : "SELL";
        const sideLevels = levels[sideIdx];

        const scanDepth = Math.min(sideLevels.length, CONFIG.maxLevelsToScan);

        for (let i = 0; i < scanDepth; i++) {
          const level = sideLevels[i];
          if (!level) continue;

          const price = parseFloat(level.px);
          const sizeBase = parseFloat(level.sz);
          const sizeUSD = price * sizeBase;

          if (sizeUSD >= threshold) {
            const distance = Math.abs((price - midPrice) / midPrice) * 100;

            if (distance <= CONFIG.maxDistancePercent) {
              if (shouldAlert(coin, sideName, level.px)) {
                const time = new Date().toLocaleTimeString();
                const volM = (sizeUSD / 1000000).toFixed(1);

                const wallet = await getWalletsByPrice(coin, level.px);

                console.log(wallet);

                // Вывод в консоль
                console.log(
                  `[${time}] 🚨 ${coin.padEnd(6)} | ${sideName.padEnd(4)} | ` +
                    `Цена: ${level.px.padEnd(10)} | Объем: $${volM}M | Дист: ${distance.toFixed(2)}%`,
                );

                // Отправка в Telegram
                const tgMessage =
                  `🟪 *Hyperliquid*\n` +
                  `*Инструмент:* \`${coin}\`\n` +
                  `*Сторона:* ${sideName === "BUY" ? "🟢 BUY (Bid)" : "🔴 SELL (Ask)"}\n` +
                  `*Цена:* \`${level.px.replace(".", ",")}\`\n` +
                  `*Объем:* \`$${volM}M\`\n` +
                  `*Дистанция:* \`${distance.toFixed(2)}%\`\n` +
                  `*Кошелек:* \`${Number(wallet?.size) > Number(sizeBase) / 2 ? wallet?.user : "Не найден"}\`\n`;

                console.log(tgMessage);

                sendTelegramAlert(tgMessage);
              }
            }
          }
        }
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`❌ [Шард ${shardId}] Ошибка:`, err.message);
  });

  ws.on("close", (code, reason) => {
    console.log(`🔌 [Шард ${shardId}] Соединение разорвано. Реконнект...`);
    clearInterval(pingInterval);
    setTimeout(() => createSocketShard(coins, shardId), CONFIG.RECONNECT_DELAY);
  });
}

// ==========================================
// 4. ГЛАВНЫЙ ЗАПУСК
// ==========================================

async function main() {
  console.log("🚀 Скринер с поддержкой Telegram запускается...");
  const allTickers = await getPerpTickers();

  for (let i = 0; i < allTickers.length; i += CONFIG.MAX_SUBS_PER_SOCKET) {
    const shardCoins = allTickers.slice(i, i + CONFIG.MAX_SUBS_PER_SOCKET);
    const shardId = Math.floor(i / CONFIG.MAX_SUBS_PER_SOCKET) + 1;
    createSocketShard(shardCoins, shardId);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main();
