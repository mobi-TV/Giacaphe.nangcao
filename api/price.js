const axios = require('axios');
const cheerio = require('cheerio');

// ======================================================
// BẢNG ĐIỀU KHIỂN TỪ XA CHO APP TV (SỬA TẠI ĐÂY KHÔNG CẦN BUILD LẠI APK)
// ======================================================
const REMOTE_CONFIG = {
  activeFromHour: 4,     // Giờ bắt đầu tự động cập nhật (giờ VN)
  activeToHour: 22,      // Giờ cuối cùng cập nhật trong ngày (23h-03h59 ngủ sâu)
  tickerSec: 8,          // Tốc độ chuyển nhóm ở chế độ Thanh 1 Dòng (giây)
  customQuote: '',       // Để trống sẽ dùng danh ngôn theo ngày; nhập chữ để ghi đè (VD: chúc Tết/lễ)
  nextApiUrl: '',        // Khi muốn đổi sang domain Vercel mới, điền link mới vào đây để TV tự chuyển
  col1Title: 'NÔNG SẢN ĐẮK LẮK (VNĐ/KG)',
  col2Title: 'VÀNG & XĂNG DẦU (VÙNG 2)',
};

const http = axios.create({
  timeout: 5500,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
  },
});

// ==========================================
// HÀM TIỆN ÍCH CHUẨN HÓA DỮ LIỆU
// ==========================================

function formatNumberVN(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '--';
  return Math.round(num)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatChangeVN(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '0';
  const rounded = Math.round(num);
  if (rounded > 0) return `+${formatNumberVN(rounded)}`;
  if (rounded < 0) return `-${formatNumberVN(Math.abs(rounded))}`;
  return '0';
}

function changeStyleOf(num) {
  if (!num || Number.isNaN(num)) return 'none';
  if (num > 0) return 'up';
  if (num < 0) return 'down';
  return 'none';
}

function parseVndPrice(text) {
  if (!text) return null;
  const matches = String(text).match(/\d{1,3}(?:[.,]\d{3})+/g);
  if (!matches || matches.length === 0) {
    const plain = String(text).replace(/[^\d]/g, '');
    const val = parseInt(plain, 10);
    return val >= 1000 ? val : null;
  }
  const nums = matches
    .map((m) => parseInt(m.replace(/[.,]/g, ''), 10))
    .filter((n) => !Number.isNaN(n) && n >= 1000);

  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  return Math.round((nums[0] + nums[1]) / 2 / 100) * 100;
}

function parseVndChange(text) {
  if (!text) return 0;
  const cleaned = String(text).trim().toLowerCase();
  if (!cleaned || /không đổi|ổn định|đi ngang|^[-–—➖0]+$/.test(cleaned)) {
    return 0;
  }
  const isNegative = /[-−▼]|giảm/.test(cleaned);
  const numMatch = cleaned.match(/\d{1,3}(?:[.,]\d{3})+|\d+/);
  if (!numMatch) return 0;

  const val = parseInt(numMatch[0].replace(/[.,]/g, ''), 10);
  if (Number.isNaN(val) || val === 0) return 0;
  return isNegative ? -val : val;
}

function normalizeGoldToTrieuLuong(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const digitsOnly = parseInt(str.replace(/[^\d]/g, ''), 10);
  if (Number.isNaN(digitsOnly) || digitsOnly === 0) return null;

  if (/^\d{2,3}\.\d{3}$/.test(str)) {
    const f = parseFloat(str);
    if (f >= 50 && f <= 300) return f;
  }
  if (digitsOnly >= 50_000_000) return digitsOnly / 1_000_000;
  if (digitsOnly >= 5_000_000) return (digitsOnly * 10) / 1_000_000;
  if (digitsOnly >= 50_000) return digitsOnly / 1_000;
  if (digitsOnly >= 5_000) return (digitsOnly * 10) / 1_000;
  return null;
}

function getVietnamTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')} - ${get('day')}/${get('month')}`;
}

function weatherIconFromWmo(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 82) return '🌦️';
  return '⛈️';
}

// ==========================================
// 1. NGUỒN QUỐC TẾ, TỶ GIÁ & THỜI TIẾT EA KIẾT
// ==========================================

async function fetchRobustaLondon() {
  try {
    const { data } = await http.post(
      'https://scanner.tradingview.com/futures/scan',
      {
        symbols: { tickers: ['ICEEUR:RC1!'], query: { types: [] } },
        columns: ['close', 'change_abs', 'change'],
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const row = data?.data?.[0]?.d;
    if (!row) return { close: null, changeUsd: 0 };

    const close = typeof row[0] === 'number' ? row[0] : null;
    let changeUsd = typeof row[1] === 'number' ? row[1] : null;
    const changePct = typeof row[2] === 'number' ? row[2] : null;

    if (changeUsd === null && close !== null && changePct !== null) {
      changeUsd = close - close / (1 + changePct / 100);
    }

    return { close, changeUsd: changeUsd ?? 0 };
  } catch (err) {
    console.error('[Robusta London Error]:', err.message);
    return { close: null, changeUsd: 0 };
  }
}

async function fetchUsdVnd() {
  try {
    const { data } = await http.get(
      'https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx'
    );
    const match = String(data).match(
      /<Exrate[^>]*CurrencyCode="USD"[^>]*Sell="([\d,\.]+)"/i
    );
    if (match && match[1]) {
      const rate = parseFloat(match[1].replace(/,/g, ''));
      if (!Number.isNaN(rate) && rate > 20000) return rate;
    }
    return 25500;
  } catch (err) {
    console.error('[Vietcombank FX Error]:', err.message);
    return 25500;
  }
}

/** Thời tiết xã Ea Kiết, Đắk Lắk (Open-Meteo miễn phí, không cần API key) */
async function fetchWeatherEaKiet() {
  try {
    const { data } = await http.get(
      'https://api.open-meteo.com/v1/forecast?latitude=12.88&longitude=108.05&current=temperature_2m,weather_code&hourly=precipitation_probability&timezone=Asia%2FHo_Chi_Minh&forecast_days=1',
      { timeout: 3500 }
    );
    const temp = data?.current?.temperature_2m;
    const code = data?.current?.weather_code ?? 1;
    if (typeof temp !== 'number') return '';

    const vnHour = parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
      10
    );
    const rainProbs = data?.hourly?.precipitation_probability || [];
    const rain = typeof rainProbs[vnHour] === 'number' ? rainProbs[vnHour] : null;
    const icon = weatherIconFromWmo(code);

    return rain !== null
      ? `${icon} Ea Kiết ${Math.round(temp)}°C • Mưa ${rain}%`
      : `${icon} Ea Kiết ${Math.round(temp)}°C`;
  } catch (err) {
    console.error('[Weather Ea Kiet Error]:', err.message);
    return '';
  }
}

// ==========================================
// 2. NGUỒN DỮ LIỆU TRONG NƯỚC (ĐẮK LẮK & HÀNG HÓA)
// ==========================================

async function fetchCoffeeDakLak() {
  const sources = [
    'https://giacaphe.com/gia-ca-phe-noi-dia/',
    'https://chogia.vn/gia-ca-phe-hom-nay/',
  ];

  for (const url of sources) {
    try {
      const { data } = await http.get(url);
      const $ = cheerio.load(data);
      let price = null;
      let change = 0;

      $('tr').each((_, el) => {
        if (price !== null) return;
        const rowText = $(el).text().replace(/\s+/g, ' ').trim();
        if (/đắk\s*lắk|đăk\s*lăk/i.test(rowText)) {
          const cells = $(el)
            .find('td, th')
            .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
            .get();

          for (let i = 1; i < cells.length; i++) {
            const p = parseVndPrice(cells[i]);
            if (p && p >= 30000 && p <= 250000) {
              price = p;
              if (cells[i + 1]) change = parseVndChange(cells[i + 1]);
              break;
            }
          }
        }
      });

      if (price !== null) return { price, change };
    } catch (err) {
      console.error(`[Coffee Error - ${url}]:`, err.message);
    }
  }
  return { price: null, change: 0 };
}

async function fetchPepperDakLak() {
  const sources = [
    'https://giatieu.com/gia-tieu-hom-nay/',
    'https://giatieu.com/',
  ];

  for (const url of sources) {
    try {
      const { data } = await http.get(url);
      const $ = cheerio.load(data);
      let price = null;
      let change = 0;

      $('tr').each((_, el) => {
        if (price !== null) return;
        const rowText = $(el).text().replace(/\s+/g, ' ').trim();
        if (/đắk\s*lắk|đăk\s*lăk/i.test(rowText)) {
          const cells = $(el)
            .find('td, th')
            .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
            .get();

          for (let i = 1; i < cells.length; i++) {
            const p = parseVndPrice(cells[i]);
            if (p && p >= 50000 && p <= 350000) {
              price = p;
              if (cells[i + 1]) change = parseVndChange(cells[i + 1]);
              break;
            }
          }
        }
      });

      if (price !== null) return { price, change };
    } catch (err) {
      console.error(`[Pepper Error - ${url}]:`, err.message);
    }
  }
  return { price: null, change: 0 };
}

async function fetchDurianDakLak() {
  const sources = [
    'https://chogia.vn/bang-gia-sau-rieng-hom-nay-47777/',
    'https://banggianongsan.com/bang-gia-sau-rieng/',
  ];

  for (const url of sources) {
    try {
      const { data } = await http.get(url);
      const $ = cheerio.load(data);
      let thaiPrice = null;
      let ri6Price = null;
      let change = 0;

      $('tr').each((_, el) => {
        const cells = $(el)
          .find('td, th')
          .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
          .get();
        if (cells.length < 2) return;

        const label = cells[0].toLowerCase();
        const priceCells = cells
          .slice(1)
          .map((c) => parseVndPrice(c))
          .filter((n) => n && n >= 20000 && n <= 250000);

        if (priceCells.length === 0) return;
        const selectedPrice = priceCells[priceCells.length - 1];

        if (!thaiPrice && /thái\s*(đẹp|loại\s*a|a\b)|monthong/i.test(label)) {
          thaiPrice = selectedPrice;
          if (cells.length >= 3 && !parseVndPrice(cells[cells.length - 1])) {
            change = parseVndChange(cells[cells.length - 1]);
          }
        } else if (!ri6Price && /ri\s*6\s*(đẹp|loại\s*a|a\b)?/i.test(label)) {
          ri6Price = selectedPrice;
        }
      });

      const finalPrice = thaiPrice || ri6Price;
      if (finalPrice !== null) return { price: finalPrice, change };
    } catch (err) {
      console.error(`[Durian Error - ${url}]:`, err.message);
    }
  }
  return { price: null, change: 0 };
}

async function fetchCashewDakLak() {
  const sources = [
    'https://giacatloi.vn/gia-thu-mua-hat-dieu-tho/',
    'https://banggianongsan.com/bang-gia-hat-dieu/',
  ];

  for (const url of sources) {
    try {
      const { data } = await http.get(url);
      const $ = cheerio.load(data);
      let price = null;
      let change = 0;

      $('tr').each((_, el) => {
        if (price !== null) return;
        const rowText = $(el).text().replace(/\s+/g, ' ').trim();
        if (/đắk\s*lắk|đăk\s*lăk/i.test(rowText)) {
          const cells = $(el)
            .find('td, th')
            .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
            .get();

          for (let i = 1; i < cells.length; i++) {
            const p = parseVndPrice(cells[i]);
            if (p && p >= 15000 && p <= 90000) {
              price = p;
              if (cells[i + 1]) change = parseVndChange(cells[i + 1]);
              break;
            }
          }
        }
      });

      if (price !== null) return { price, change };
    } catch (err) {
      console.error(`[Cashew Error - ${url}]:`, err.message);
    }
  }
  return { price: null, change: 0 };
}

async function fetchGoldSjc() {
  try {
    const { data } = await http.get('https://sjc.com.vn/xml/tygiavang.xml');
    const match =
      String(data).match(
        /<item[^>]*buy="([\d,\.]+)"[^>]*sell="([\d,\.]+)"[^>]*type="[^"]*SJC\s*1L[^"]*"/i
      ) ||
      String(data).match(
        /<item[^>]*type="[^"]*SJC\s*1L[^"]*"[^>]*buy="([\d,\.]+)"[^>]*sell="([\d,\.]+)"/i
      );

    if (match) {
      const buy = normalizeGoldToTrieuLuong(match[1]);
      const sell = normalizeGoldToTrieuLuong(match[2]);
      if (buy && sell) return `${buy.toFixed(1)} - ${sell.toFixed(1)}`;
    }
  } catch (err) {
    console.error('[SJC XML Error]:', err.message);
  }

  try {
    const { data } = await http.get('https://webgia.com/gia-vang/sjc/');
    const $ = cheerio.load(data);
    let result = null;

    $('tr').each((_, el) => {
      if (result) return;
      const cells = $(el)
        .find('td, th')
        .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
        .get();
      if (cells.length >= 3 && /SJC\s*1L|1L,\s*10L/i.test(cells[0])) {
        const buy = normalizeGoldToTrieuLuong(cells[1]);
        const sell = normalizeGoldToTrieuLuong(cells[2]);
        if (buy && sell) result = `${buy.toFixed(1)} - ${sell.toFixed(1)}`;
      }
    });

    if (result) return result;
  } catch (err) {
    console.error('[SJC Fallback Error]:', err.message);
  }

  return '--';
}

async function fetchFuelPetrolimexV2() {
  const result = { ron95: null, e5: null, do005s: null };

  try {
    const { data } = await http.get(
      'https://webgia.com/gia-xang-dau/petrolimex/'
    );
    const $ = cheerio.load(data);

    $('tr').each((_, el) => {
      const cells = $(el)
        .find('td, th')
        .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
        .get();
      if (cells.length < 3) return;

      const name = cells[0];
      const vung2 = parseVndPrice(cells[2]);
      if (!vung2 || vung2 < 10000 || vung2 > 50000) return;

      if (!result.ron95 && /RON\s*95[-\s]*(III|mức\s*3)/i.test(name)) {
        result.ron95 = vung2;
      } else if (!result.e5 && /E5\s*RON\s*92/i.test(name)) {
        result.e5 = vung2;
      } else if (!result.do005s && /DO\s*0[.,]05S/i.test(name)) {
        result.do005s = vung2;
      }
    });
  } catch (err) {
    console.error('[Fuel Petrolimex Error]:', err.message);
  }

  return result;
}

// ==========================================
// 3. HANDLER CHÍNH (SERVER-DRIVEN UI JSON)
// ==========================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const [
    robustaRes,
    usdRes,
    weatherRes,
    coffeeRes,
    pepperRes,
    durianRes,
    cashewRes,
    goldRes,
    fuelRes,
  ] = await Promise.allSettled([
    fetchRobustaLondon(),
    fetchUsdVnd(),
    fetchWeatherEaKiet(),
    fetchCoffeeDakLak(),
    fetchPepperDakLak(),
    fetchDurianDakLak(),
    fetchCashewDakLak(),
    fetchGoldSjc(),
    fetchFuelPetrolimexV2(),
  ]);

  const robusta =
    robustaRes.status === 'fulfilled'
      ? robustaRes.value
      : { close: null, changeUsd: 0 };
  const usdVnd = usdRes.status === 'fulfilled' ? usdRes.value : 25500;
  const topExtra = weatherRes.status === 'fulfilled' ? weatherRes.value : '';
  const coffee =
    coffeeRes.status === 'fulfilled'
      ? coffeeRes.value
      : { price: null, change: 0 };
  const pepper =
    pepperRes.status === 'fulfilled'
      ? pepperRes.value
      : { price: null, change: 0 };
  const durian =
    durianRes.status === 'fulfilled'
      ? durianRes.value
      : { price: null, change: 0 };
  const cashew =
    cashewRes.status === 'fulfilled'
      ? cashewRes.value
      : { price: null, change: 0 };
  const goldSjc = goldRes.status === 'fulfilled' ? goldRes.value : '--';
  const fuel =
    fuelRes.status === 'fulfilled'
      ? fuelRes.value
      : { ron95: null, e5: null, do005s: null };

  // Tự hiệu chuẩn giá cà phê thực tế từ mốc Đắk Lắk + biến động sàn London
  const londonChangeUsd = robusta.changeUsd || 0;
  const deltaVndPerKg =
    Math.round(((londonChangeUsd * usdVnd) / 1000) / 100) * 100;

  let cfThucTeVal = null;
  if (coffee.price !== null) {
    cfThucTeVal = coffee.price + deltaVndPerKg;
  } else if (robusta.close !== null) {
    cfThucTeVal = Math.round(((robusta.close * usdVnd) / 1000) / 100) * 100;
  }

  let cfXuHuong = '➖ Đi ngang';
  let cfTrendStyle = 'neutral';
  if (londonChangeUsd > 0) {
    cfXuHuong = '▲ Tăng';
    cfTrendStyle = 'trend_up';
  } else if (londonChangeUsd < 0) {
    cfXuHuong = '▼ Giảm';
    cfTrendStyle = 'trend_down';
  }

  const cfThiTruongStr = formatNumberVN(coffee.price);
  const cfThiTruongChgStr = formatChangeVN(coffee.change);
  const cfThucTeStr = formatNumberVN(cfThucTeVal);
  const pepperStr = formatNumberVN(pepper.price);
  const pepperChgStr = formatChangeVN(pepper.change);
  const durianStr = formatNumberVN(durian.price);
  const durianChgStr = formatChangeVN(durian.change);
  const cashewStr = formatNumberVN(cashew.price);
  const cashewChgStr = formatChangeVN(cashew.change);
  const ron95Str = formatNumberVN(fuel.ron95);
  const e5Str = formatNumberVN(fuel.e5);
  const do005sStr = formatNumberVN(fuel.do005s);
  const updatedAt = getVietnamTimestamp();

  // Xuất JSON chuẩn Server-Driven UI (thêm/bớt phần tử trong items -> TV tự vẽ lại)
  const payload = {
    config: {
      activeFromHour: REMOTE_CONFIG.activeFromHour,
      activeToHour: REMOTE_CONFIG.activeToHour,
      tickerSec: REMOTE_CONFIG.tickerSec,
      topExtra,
      quote: REMOTE_CONFIG.customQuote,
      nextApiUrl: REMOTE_CONFIG.nextApiUrl,
    },
    col1: {
      title: REMOTE_CONFIG.col1Title,
      items: [
        {
          label: '☕ Giá thị trường Đắk Lắk',
          val: cfThiTruongStr,
          badge: cfThiTruongChgStr,
          style: changeStyleOf(coffee.change),
        },
        {
          label: '📈 Giá thực tế (Sàn)',
          val: cfThucTeStr,
          badge: cfXuHuong,
          style: cfTrendStyle,
        },
        {
          label: '🌿 Hồ tiêu Đắk Lắk',
          val: pepperStr,
          badge: pepperChgStr,
          style: changeStyleOf(pepper.change),
        },
        {
          label: '🍈 Sầu riêng Đắk Lắk',
          val: durianStr,
          badge: durianChgStr,
          style: changeStyleOf(durian.change),
        },
        {
          label: '🌰 Hạt điều',
          val: cashewStr,
          badge: cashewChgStr,
          style: changeStyleOf(cashew.change),
        },
      ],
    },
    col2: {
      title: REMOTE_CONFIG.col2Title,
      items: [
        { label: '🪙 Vàng SJC:', val: goldSjc },
        { label: '⛽ RON 95-III:', val: ron95Str },
        { label: '⛽ E5 RON 92:', val: e5Str },
        { label: '🛢️ Dầu DO 0.05S:', val: do005sStr },
        { label: '🕒 Cập nhật:', val: updatedAt, muted: true },
      ],
    },
    tickers: [
      {
        text: `☕ TT Đắk Lắk: ${cfThiTruongStr}  •  Sàn: ${cfThucTeStr}`,
        badge: cfXuHuong,
        style: cfTrendStyle,
      },
      {
        text: `🌿 Tiêu: ${pepperStr}  •  🍈 Sầu riêng: ${durianStr}  •  🌰 Điều: ${cashewStr}`,
        badge: '',
        style: 'none',
      },
      {
        text: `🪙 SJC: ${goldSjc}  •  ⛽ 95: ${ron95Str}  •  🛢️ DO: ${do005sStr}`,
        badge: '',
        style: 'none',
      },
    ],
  };

  return res.status(200).json(payload);
};
