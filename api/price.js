const axios = require('axios');
const cheerio = require('cheerio');

// Cấu hình HTTP Client chung: timeout ngắn để đảm bảo không vượt trần 10s của Vercel Hobby
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
// CÁC HÀM TIỆN ÍCH CHUẨN HÓA DỮ LIỆU
// ==========================================

/** Định dạng số nguyên có dấu phẩy ngăn cách hàng nghìn: 71500 -> "71,500" */
function formatNumberVN(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '--';
  return Math.round(num)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Định dạng mức thay đổi có dấu +/-: 600 -> "+600", -2000 -> "-2,000", 0 -> "0" */
function formatChangeVN(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '0';
  const rounded = Math.round(num);
  if (rounded > 0) return `+${formatNumberVN(rounded)}`;
  if (rounded < 0) return `-${formatNumberVN(Math.abs(rounded))}`;
  return '0';
}

/**
 * Tách giá VNĐ từ chuỗi bất kỳ (VD: "70.400đ/kg", "70,400", "25.000 - 30.000").
 * Nếu là khoảng giá (range), tự động lấy trung bình làm tròn đến hàng trăm.
 */
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
  // Trung bình khoảng giá, làm tròn bội số 100đ
  return Math.round((nums[0] + nums[1]) / 2 / 100) * 100;
}

/** Tách mức tăng/giảm từ ô bảng (VD: "+600", "-2,000", "giảm 1.500", "Không đổi") */
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

/** Quy đổi mọi đơn vị giá vàng SJC (VNĐ/chỉ, VNĐ/lượng, nghìn/lượng, triệu/lượng) về Triệu/lượng */
function normalizeGoldToTrieuLuong(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const digitsOnly = parseInt(str.replace(/[^\d]/g, ''), 10);
  if (Number.isNaN(digitsOnly) || digitsOnly === 0) return null;

  // Dạng "85.000" (triệu/lượng trong XML SJC) -> 85.0
  if (/^\d{2,3}\.\d{3}$/.test(str)) {
    const f = parseFloat(str);
    if (f >= 50 && f <= 300) return f;
  }
  // Dạng VNĐ/lượng (VD: 85.000.000 hoặc 131.000.000)
  if (digitsOnly >= 50_000_000) return digitsOnly / 1_000_000;
  // Dạng VNĐ/chỉ (VD: 8.500.000 hoặc 13.100.000 trên webgia) -> x10 thành lượng
  if (digitsOnly >= 5_000_000) return (digitsOnly * 10) / 1_000_000;
  // Dạng nghìn đồng/lượng (VD: 85,000 hoặc 131,000)
  if (digitsOnly >= 50_000) return digitsOnly / 1_000;
  // Dạng nghìn đồng/chỉ (VD: 8,500 hoặc 13,100)
  if (digitsOnly >= 5_000) return (digitsOnly * 10) / 1_000;

  return null;
}

/** Lấy thời gian hiện tại theo múi giờ Việt Nam định dạng "HH:mm - dd/MM" */
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

// ==========================================
// 1. NGUỒN DỮ LIỆU QUỐC TẾ & TỶ GIÁ
// ==========================================

/** Lấy giá Robusta London kỳ hạn gần nhất (ICEEUR:RC1!) từ TradingView Scanner */
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

    // Fallback tính change tuyệt đối nếu TradingView không trả về change_abs
    if (changeUsd === null && close !== null && changePct !== null) {
      changeUsd = close - close / (1 + changePct / 100);
    }

    return { close, changeUsd: changeUsd ?? 0 };
  } catch (err) {
    console.error('[Robusta London Error]:', err.message);
    return { close: null, changeUsd: 0 };
  }
}

/** Lấy tỷ giá USD bán ra thực tế từ XML công khai của Vietcombank */
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
    return 25500; // Mốc dự phòng an toàn nếu VCB bảo trì
  } catch (err) {
    console.error('[Vietcombank FX Error]:', err.message);
    return 25500;
  }
}

// ==========================================
// 2. NGUỒN DỮ LIỆU TRONG NƯỚC (ĐẮK LẮK & HÀNG HÓA)
// ==========================================

/** Giá cà phê nhân xô Đắk Lắk (Primary: giacaphe.com | Fallback: chogia.vn) */
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

/** Giá Hồ tiêu Đắk Lắk (Primary: giatieu.com) */
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

/** Giá Sầu riêng Đắk Lắk / Tây Nguyên - ưu tiên Thái đẹp, fallback Ri6 */
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
        // Lấy cột Tây Nguyên (thường là cột cuối nếu có nhiều vùng, hoặc cột thứ 2)
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

/** Giá Hạt điều thô Đắk Lắk (Primary: giacatloi.vn | Fallback: banggianongsan.com) */
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

/** Giá Vàng miếng SJC quy đổi triệu/lượng dạng "85.0 - 87.0" */
async function fetchGoldSjc() {
  // Primary: XML chính thức của SJC
  try {
    const { data } = await http.get('https://sjc.com.vn/xml/tygiavang.xml');
    const match = String(data).match(
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

  // Fallback: webgia.com
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

/** Giá Xăng dầu Petrolimex Vùng 2 (RON 95-III, E5 RON 92, Dầu DO 0,05S) */
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
      // Bảng Petrolimex chuẩn: [Tên sản phẩm, Vùng 1, Vùng 2] -> lấy cột Vùng 2 (index 2)
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
// 3. HANDLER CHÍNH (VERCEL SERVERLESS FUNCTION)
// ==========================================

module.exports = async function handler(req, res) {
  // Cấu hình CORS & Edge Caching (CDN Vercel cache 5 phút, serve stale thêm 60s)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader(
    'Cache-Control',
    's-maxage=300, stale-while-revalidate=60'
  );
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Chạy song song toàn bộ 8 nguồn dữ liệu độc lập
  const [
    robustaRes,
    usdRes,
    coffeeRes,
    pepperRes,
    durianRes,
    cashewRes,
    goldRes,
    fuelRes,
  ] = await Promise.allSettled([
    fetchRobustaLondon(),
    fetchUsdVnd(),
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

  // ==========================================
  // CƠ CHẾ TỰ HIỆU CHUẨN (AUTO-CALIBRATION) & XU HƯỚNG
  // ==========================================
  const londonChangeUsd = robusta.changeUsd || 0;

  // Quy đổi biến động sàn London (USD/tấn) -> VNĐ/kg, làm tròn bội số 100đ
  const deltaVndPerKg =
    Math.round(((londonChangeUsd * usdVnd) / 1000) / 100) * 100;

  // Lấy giá cà phê thị trường Đắk Lắk làm mốc chuẩn, cộng/trừ biến động sàn London
  let cfThucTeVal = null;
  if (coffee.price !== null) {
    cfThucTeVal = coffee.price + deltaVndPerKg;
  } else if (robusta.close !== null) {
    // Dự phòng nếu trang cà phê nội địa lỗi: quy đổi trực tiếp từ giá sàn London
    cfThucTeVal = Math.round(((robusta.close * usdVnd) / 1000) / 100) * 100;
  }

  let cfXuHuong = '➖ Đi ngang';
  if (londonChangeUsd > 0) {
    cfXuHuong = '▲ Tăng';
  } else if (londonChangeUsd < 0) {
    cfXuHuong = '▼ Giảm';
  }

  // ==========================================
  // ĐẦU RA JSON SIÊU NHẸ CHO ANDROID TV
  // ==========================================
  const payload = {
    cfThiTruong: formatNumberVN(coffee.price),
    cfThiTruongChg: formatChangeVN(coffee.change),
    cfThucTe: formatNumberVN(cfThucTeVal),
    cfXuHuong,
    pepper: formatNumberVN(pepper.price),
    pepperChg: formatChangeVN(pepper.change),
    durian: formatNumberVN(durian.price),
    durianChg: formatChangeVN(durian.change),
    cashew: formatNumberVN(cashew.price),
    cashewChg: formatChangeVN(cashew.change),
    goldSjc,
    ron95: formatNumberVN(fuel.ron95),
    e5: formatNumberVN(fuel.e5),
    do005s: formatNumberVN(fuel.do005s),
    updatedAt: getVietnamTimestamp(),
  };

  return res.status(200).json(payload);
};
