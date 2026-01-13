const WebSocket = require("ws");
const axios = require("axios");

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  apiUrl: "https://api.hyperliquid.xyz/info",
  wsUrl: "wss://api.hyperliquid.xyz/ws",

  // --- Пороги объема в USD ---
  defaultThresholdUSD: 500000, // 1 млн $ по умолчанию
  customThresholdsUSD: {
    BTC: 30000000, // 30 млн $
    ETH: 20000000, // 20 млн $
    SOL: 10000000, // 10 млн $
    XRP: 10000000,
    HYPE: 5000000, // 5 млн $
  },

  // --- Оптимизация спама ---
  maxDistancePercent: 3, // Игнорировать плотности дальше 3% от цены
  alertCooldownMs: 60000, // Не писать об одной цене чаще чем раз в минуту
  maxLevelsToScan: 100, // Проверять только первые 100 заявок в стакане

  // --- Технические настройки ---
  MAX_SUBS_PER_SOCKET: 80, // Монет на одно соединение
  SUB_DELAY_MS: 100, // Пауза между подписками во избежание бана
  RECONNECT_DELAY: 5000, // Пауза при обрыве связи
};

// Хранилище для кулдауна уведомлений
const alertCache = new Map();

// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

/**
 * Проверка кулдауна уведомлений (чтобы не спамить одну цену)
 */
function shouldAlert(coin, side, price) {
  const key = `${coin}_${side}_${price}`;
  const now = Date.now();

  if (alertCache.has(key)) {
    const lastTime = alertCache.get(key);
    if (now - lastTime < CONFIG.alertCooldownMs) return false;
  }

  alertCache.set(key, now);

  // Очистка старого кэша раз в час
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
    const tickers = res.data.universe.map((u) => {
      console.log(u.name);
      return u.name;
    });

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

    // Пинг для поддержания связи (Heartbeat)
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: "ping" }));
      }
    }, 15000);

    // Подписка на стаканы
    for (const coin of coins) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            method: "subscribe",
            subscription: { type: "l2Book", coin: coin },
          })
        );
        await new Promise((r) => setTimeout(r, CONFIG.SUB_DELAY_MS));
      }
    }
  });

  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (e) {
      return;
    }

    if (message.channel === "pong") return;

    if (message.channel === "l2Book" && message.data) {
      const { coin, levels } = message.data;

      // ЗАЩИТА: Проверяем, что обе стороны стакана существуют и не пусты
      if (!levels || !levels[0] || !levels[1] || levels[0].length === 0 || levels[1].length === 0) {
        return;
      }

      const threshold = CONFIG.customThresholdsUSD[coin] || CONFIG.defaultThresholdUSD;

      // Безопасное получение цен лучших Bid/Ask
      const bestBid = parseFloat(levels[0][0].px);
      const bestAsk = parseFloat(levels[1][0].px);

      if (isNaN(bestBid) || isNaN(bestAsk)) return;

      const midPrice = (bestBid + bestAsk) / 2;

      // Проходим по Bids (покупки) и Asks (продажи)
      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const sideName = sideIdx === 0 ? "BUY " : "SELL";
        const sideLevels = levels[sideIdx];

        // Сканируем только верхнюю часть стакана
        const scanDepth = Math.min(sideLevels.length, CONFIG.maxLevelsToScan);

        for (let i = 0; i < scanDepth; i++) {
          const level = sideLevels[i];
          if (!level) continue;

          const price = parseFloat(level.px);
          const sizeBase = parseFloat(level.sz);
          const sizeUSD = price * sizeBase;

          // Фильтр 1: Порог объема
          if (sizeUSD >= threshold) {
            // Фильтр 2: Дистанция от текущей цены
            const distance = Math.abs((price - midPrice) / midPrice) * 100;

            if (distance <= CONFIG.maxDistancePercent) {
              // Фильтр 3: Кулдаун (анти-спам)
              if (shouldAlert(coin, sideName, level.px)) {
                const time = new Date().toLocaleTimeString();
                console.log(
                  `[${time}] 🚨 ${coin.padEnd(6)} | ${sideName} | ` +
                    `Цена: ${level.px.padEnd(10)} | ` +
                    `Объем: $${(sizeUSD / 1000000).toFixed(1)}M | ` +
                    `Дист: ${distance.toFixed(2)}%`
                );
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
    console.log(`🔌 [Шард ${shardId}] Соединение разорвано (Код: ${code}). Реконнект...`);
    clearInterval(pingInterval);
    setTimeout(() => createSocketShard(coins, shardId), CONFIG.RECONNECT_DELAY);
  });
}

// ==========================================
// 4. ГЛАВНЫЙ ЗАПУСК
// ==========================================

async function main() {
  console.log("🚀 Скринер фьючерсов Hyperliquid (Оптимизированный) запускается...");
  const allTickers = await getPerpTickers();

  // Разбиваем тикеры на группы (шарды)
  for (let i = 0; i < allTickers.length; i += CONFIG.MAX_SUBS_PER_SOCKET) {
    const shardCoins = allTickers.slice(i, i + CONFIG.MAX_SUBS_PER_SOCKET);
    const shardId = Math.floor(i / CONFIG.MAX_SUBS_PER_SOCKET) + 1;

    // Запуск шарда
    createSocketShard(shardCoins, shardId);

    // Задержка между открытием новых сокетов
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `🔥 Работает ${Math.ceil(allTickers.length / CONFIG.MAX_SUBS_PER_SOCKET)} WebSocket соединений.`
  );
}

main();
