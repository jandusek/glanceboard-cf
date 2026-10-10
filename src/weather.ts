export interface Weather {
  /** The day's high, which is what people dress for. */
  high: number;
  low: number;
  unit: "°C" | "°F";
  condition: string;
  emoji: string;
  clothing: string;
}

const WMO: Record<number, [string, string]> = {
  0: ["Clear sky", "☀️"],
  1: ["Mainly clear", "🌤️"],
  2: ["Partly cloudy", "⛅"],
  3: ["Overcast", "☁️"],
  45: ["Foggy", "🌫️"],
  48: ["Icy fog", "🌫️"],
  51: ["Light drizzle", "🌦️"],
  53: ["Drizzle", "🌦️"],
  55: ["Heavy drizzle", "🌧️"],
  56: ["Freezing drizzle", "🌧️"],
  57: ["Heavy freezing drizzle", "🌧️"],
  61: ["Light rain", "🌦️"],
  63: ["Rain", "🌧️"],
  65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"],
  67: ["Heavy freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"],
  73: ["Snow", "🌨️"],
  75: ["Heavy snow", "❄️"],
  77: ["Snow grains", "🌨️"],
  80: ["Light showers", "🌦️"],
  81: ["Showers", "🌧️"],
  82: ["Heavy showers", "⛈️"],
  85: ["Light snow showers", "🌨️"],
  86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"],
  96: ["Thunderstorm with hail", "⛈️"],
  99: ["Heavy thunderstorm with hail", "⛈️"],
};

const RAIN = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99]);
const SNOW = new Set([71, 73, 75, 77, 85, 86]);

/**
 * Today's forecast from Open-Meteo. Uses the daily weather code rather than the
 * current one, so the prompt (and the skip-if-unchanged hash) stays stable all day.
 */
export async function fetchWeather(
  latitude: number, longitude: number, unit: "celsius" | "fahrenheit", timeZone: string,
): Promise<Weather> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    temperature_unit: unit,
    forecast_days: "1",
    timezone: timeZone,
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo returned HTTP ${res.status}`);
  const data = (await res.json()) as {
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[] };
  };
  const high = Math.round(data.daily.temperature_2m_max[0]);
  const low = Math.round(data.daily.temperature_2m_min[0]);
  const code = data.daily.weather_code[0];
  const [condition, emoji] = WMO[code] ?? ["Unknown", "🌡️"];
  const highC = unit === "celsius" ? high : ((high - 32) * 5) / 9;
  return { high, low, unit: unit === "celsius" ? "°C" : "°F", condition, emoji, clothing: clothingFor(highC, code) };
}

export function clothingFor(highC: number, code: number): string {
  let hint =
    highC >= 30 ? "light summer clothes (shorts, t-shirts, sun hats)"
    : highC >= 22 ? "casual warm-weather clothes (t-shirts, light pants)"
    : highC >= 15 ? "layers or light jumpers"
    : highC >= 8 ? "warm clothes (jackets, long pants)"
    : highC >= 0 ? "heavy winter clothes (coats, scarves, beanies)"
    : "very heavy winter gear (thick coats, gloves, boots)";
  if (RAIN.has(code)) hint += ", with rain gear (umbrellas, rain jackets)";
  else if (SNOW.has(code)) hint += ", with snow gear";
  return hint;
}

/** Hemisphere-aware season name; the tropics get no season. */
export function seasonFor(month: number, latitude: number | null): string {
  if (latitude !== null && Math.abs(latitude) < 23.5) return "warm tropical";
  const north = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"];
  const season = north[month - 1];
  if (latitude === null || latitude >= 0) return season;
  return ({ winter: "summer", summer: "winter", spring: "autumn", autumn: "spring" } as Record<string, string>)[season];
}
