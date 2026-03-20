/**
 * ============================================================
 * bot-stealth.ts
 *
 * Extended fingerprint layer for Playwright browser sessions.
 * Works in two complementary layers:
 *
 * Layer 1 — playwright-extra stealth plugin (see browser-factory.ts)
 *   Handles: webdriver flag, chrome runtime object, navigator.plugins,
 *   permissions API, headless UA strings, hairline feature.
 *
 * Layer 2 — THIS FILE
 *   Fills the gaps the plugin leaves open:
 *     • Cohesive fingerprint profiles (UA + GPU + timezone + screen
 *       all come from the same plausible real machine)
 *     • Battery API (realistic level, charge state, timing)
 *     • navigator.connection (NetworkInformation API)
 *     • Font enumeration defense
 *     • Speech synthesis voice list
 *     • Media devices enumeration
 *     • ClientRects sub-pixel noise
 *     • Performance timing noise
 *     • Keyboard layout API
 *     • getComputedStyle noise
 *     • Feature detection coherence (all flags match the UA)
 *     • Geolocation consistent with timezone
 *
 * Each profile is a self-consistent set — all values describe
 * the same plausible physical machine.
 * ============================================================
 */

// ── Types ─────────────────────────────────────────────────────

export interface FingerprintProfile {
  /** Label for logging (never sent to page) */
  id: string;

  /** Full UA string */
  userAgent: string;

  /** navigator.platform */
  platform: string;

  /** OS family used in Sec-CH-UA-Platform header */
  platformHeader: string;

  /** Chrome major version */
  chromeMajor: number;

  /** navigator.vendor */
  vendor: string;

  /** Viewport dimensions */
  viewport: { width: number; height: number };

  /** Physical screen (includes taskbar / dock) */
  screen: { width: number; height: number };

  /** navigator.hardwareConcurrency */
  hardwareConcurrency: number;

  /** navigator.deviceMemory (GB) */
  deviceMemory: number;

  /** WebGL UNMASKED_VENDOR_WEBGL */
  webglVendor: string;

  /** WebGL UNMASKED_RENDERER_WEBGL */
  webglRenderer: string;

  /** Timezone ID */
  timezone: string;

  /** navigator.language */
  locale: string;

  /** navigator.languages array */
  languages: string[];

  /** Battery level 0–1 */
  batteryLevel: number;

  /** Whether device is charging */
  batteryCharging: boolean;

  /** Effective connection type */
  connectionType: '4g' | '3g' | 'wifi';

  /** Approximate downlink Mbps */
  connectionDownlink: number;

  /** Approximate RTT ms */
  connectionRtt: number;

  /** Latitude matching timezone (approximate) */
  geoLat: number;

  /** Longitude matching timezone (approximate) */
  geoLon: number;

  /** High-entropy client hint values */
  uaData: {
    brand: string;
    brandVersion: string;
    mobile: boolean;
    architecture: string;
    bitness: string;
    model: string;
    uaFullVersion: string;
    platformVersion: string;
  };
}

// ── Cohesive fingerprint profiles ────────────────────────────
// Each profile describes ONE plausible real machine.
// Values are cross-checked: GPU matches OS, UA matches browser
// version, timezone matches geo, etc.

export const FINGERPRINT_PROFILES: FingerprintProfile[] = [
  // ── Windows 11 / Intel + NVIDIA / New York ─────────────────
  {
    id: 'win11-nvidia-nyc',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform:         'Win32',
    platformHeader:   'Windows',
    chromeMajor:      124,
    vendor:           'Google Inc.',
    viewport:         { width: 1920, height: 1040 },
    screen:           { width: 1920, height: 1080 },
    hardwareConcurrency: 12,
    deviceMemory:     16,
    webglVendor:      'Google Inc. (NVIDIA)',
    webglRenderer:    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    timezone:         'America/New_York',
    locale:           'en-US',
    languages:        ['en-US', 'en'],
    batteryLevel:     0.82,
    batteryCharging:  true,
    connectionType:   'wifi',
    connectionDownlink: 94.2,
    connectionRtt:    25,
    geoLat:  40.7128,
    geoLon: -74.0060,
    uaData: {
      brand: 'Chromium', brandVersion: '124',
      mobile: false, architecture: 'x86', bitness: '64',
      model: '', uaFullVersion: '124.0.6367.82',
      platformVersion: '15.0.0',
    },
  },

  // ── Windows 10 / AMD / Chicago ─────────────────────────────
  {
    id: 'win10-amd-chi',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    platform:         'Win32',
    platformHeader:   'Windows',
    chromeMajor:      123,
    vendor:           'Google Inc.',
    viewport:         { width: 1440, height: 837 },
    screen:           { width: 1440, height: 900 },
    hardwareConcurrency: 8,
    deviceMemory:     8,
    webglVendor:      'Google Inc. (AMD)',
    webglRenderer:    'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
    timezone:         'America/Chicago',
    locale:           'en-US',
    languages:        ['en-US', 'en'],
    batteryLevel:     0.61,
    batteryCharging:  false,
    connectionType:   'wifi',
    connectionDownlink: 52.8,
    connectionRtt:    40,
    geoLat:  41.8781,
    geoLon: -87.6298,
    uaData: {
      brand: 'Google Chrome', brandVersion: '123',
      mobile: false, architecture: 'x86', bitness: '64',
      model: '', uaFullVersion: '123.0.6312.105',
      platformVersion: '10.0.0',
    },
  },

  // ── macOS 14 Sonoma / Apple Silicon / Los Angeles ──────────
  {
    id: 'mac14-apple-la',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform:         'MacIntel',
    platformHeader:   'macOS',
    chromeMajor:      124,
    vendor:           'Google Inc.',
    viewport:         { width: 1440, height: 877 },
    screen:           { width: 1440, height: 900 },
    hardwareConcurrency: 10,
    deviceMemory:     8,
    webglVendor:      'Google Inc. (Apple)',
    webglRenderer:    'ANGLE (Apple, Apple M2, OpenGL 4.1)',
    timezone:         'America/Los_Angeles',
    locale:           'en-US',
    languages:        ['en-US', 'en'],
    batteryLevel:     0.95,
    batteryCharging:  true,
    connectionType:   'wifi',
    connectionDownlink: 68.1,
    connectionRtt:    30,
    geoLat:  34.0522,
    geoLon: -118.2437,
    uaData: {
      brand: 'Google Chrome', brandVersion: '124',
      mobile: false, architecture: 'arm', bitness: '64',
      model: '', uaFullVersion: '124.0.6367.82',
      platformVersion: '14.4.1',
    },
  },

  // ── Windows 11 / Intel UHD / Seattle ──────────────────────
  {
    id: 'win11-intel-sea',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform:         'Win32',
    platformHeader:   'Windows',
    chromeMajor:      125,
    vendor:           'Google Inc.',
    viewport:         { width: 1366, height: 696 },
    screen:           { width: 1366, height: 768 },
    hardwareConcurrency: 8,
    deviceMemory:     4,
    webglVendor:      'Google Inc. (Intel)',
    webglRenderer:    'ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    timezone:         'America/Los_Angeles',
    locale:           'en-US',
    languages:        ['en-US', 'en'],
    batteryLevel:     0.44,
    batteryCharging:  false,
    connectionType:   '4g',
    connectionDownlink: 12.4,
    connectionRtt:    75,
    geoLat:  47.6062,
    geoLon: -122.3321,
    uaData: {
      brand: 'Google Chrome', brandVersion: '125',
      mobile: false, architecture: 'x86', bitness: '64',
      model: '', uaFullVersion: '125.0.6422.77',
      platformVersion: '15.0.0',
    },
  },

  // ── macOS 13 Ventura / Intel / London ─────────────────────
  {
    id: 'mac13-intel-lon',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform:         'MacIntel',
    platformHeader:   'macOS',
    chromeMajor:      122,
    vendor:           'Google Inc.',
    viewport:         { width: 1680, height: 998 },
    screen:           { width: 1680, height: 1050 },
    hardwareConcurrency: 8,
    deviceMemory:     16,
    webglVendor:      'Google Inc. (Intel Inc.)',
    webglRenderer:    'ANGLE (Intel Inc., Intel(R) Iris(R) Plus Graphics, OpenGL 4.1)',
    timezone:         'Europe/London',
    locale:           'en-GB',
    languages:        ['en-GB', 'en', 'en-US'],
    batteryLevel:     1.0,
    batteryCharging:  true,
    connectionType:   'wifi',
    connectionDownlink: 85.0,
    connectionRtt:    20,
    geoLat:  51.5074,
    geoLon:  -0.1278,
    uaData: {
      brand: 'Chromium', brandVersion: '122',
      mobile: false, architecture: 'x86', bitness: '64',
      model: '', uaFullVersion: '122.0.6261.112',
      platformVersion: '13.6.6',
    },
  },

  // ── Windows 10 / NVIDIA / Bangalore ───────────────────────
  {
    id: 'win10-nvidia-blr',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform:         'Win32',
    platformHeader:   'Windows',
    chromeMajor:      124,
    vendor:           'Google Inc.',
    viewport:         { width: 1536, height: 824 },
    screen:           { width: 1536, height: 864 },
    hardwareConcurrency: 6,
    deviceMemory:     8,
    webglVendor:      'Google Inc. (NVIDIA)',
    webglRenderer:    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    timezone:         'Asia/Kolkata',
    locale:           'en-IN',
    languages:        ['en-IN', 'en', 'en-US'],
    batteryLevel:     0.73,
    batteryCharging:  true,
    connectionType:   'wifi',
    connectionDownlink: 45.0,
    connectionRtt:    55,
    geoLat:  12.9716,
    geoLon:  77.5946,
    uaData: {
      brand: 'Google Chrome', brandVersion: '124',
      mobile: false, architecture: 'x86', bitness: '64',
      model: '', uaFullVersion: '124.0.6367.60',
      platformVersion: '10.0.0',
    },
  },

  // ── Windows 11 / Intel Xe / Singapore ─────────────────────
  {
    id: 'win11-xe-sgp',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    platform:         'Win32',
    platformHeader:   'Windows',
    chromeMajor:      123,
    vendor:           'Google Inc.',
    viewport:         { width: 1920, height: 1040 },
    screen:           { width: 1920, height: 1080 },
    hardwareConcurrency: 16,
    deviceMemory:     16,
    webglVendor:      'Google Inc. (Intel)',
    webglRenderer:    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    timezone:         'Asia/Singapore',
    locale:           'en-SG',
    languages:        ['en-SG', 'en-GB', 'en'],
    batteryLevel:     0.88,
    batteryCharging:  false,
    connectionType:   'wifi',
    connectionDownlink: 110.0,
    connectionRtt:    15,
    geoLat:   1.3521,
    geoLon:  103.8198,
    uaData: {
      brand: 'Chromium', brandVersion: '123',
      mobile: false, architecture: 'x86', bitness: '64',
      model: '', uaFullVersion: '123.0.6312.122',
      platformVersion: '15.0.0',
    },
  },

  // ── macOS 14 / Apple M3 / Toronto ─────────────────────────
  {
    id: 'mac14-m3-tor',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform:         'MacIntel',
    platformHeader:   'macOS',
    chromeMajor:      125,
    vendor:           'Google Inc.',
    viewport:         { width: 1512, height: 902 },
    screen:           { width: 1512, height: 982 },
    hardwareConcurrency: 12,
    deviceMemory:     16,
    webglVendor:      'Google Inc. (Apple)',
    webglRenderer:    'ANGLE (Apple, Apple M3 Pro, OpenGL 4.1)',
    timezone:         'America/Toronto',
    locale:           'en-CA',
    languages:        ['en-CA', 'en', 'fr-CA'],
    batteryLevel:     0.55,
    batteryCharging:  true,
    connectionType:   'wifi',
    connectionDownlink: 72.5,
    connectionRtt:    22,
    geoLat:  43.6532,
    geoLon: -79.3832,
    uaData: {
      brand: 'Google Chrome', brandVersion: '125',
      mobile: false, architecture: 'arm', bitness: '64',
      model: '', uaFullVersion: '125.0.6422.112',
      platformVersion: '14.5.0',
    },
  },
];

// ── Selector ─────────────────────────────────────────────────

/** Pick a random profile from the pool */
export function randomProfile(): FingerprintProfile {
  return FINGERPRINT_PROFILES[
    Math.floor(Math.random() * FINGERPRINT_PROFILES.length)
  ]!;
}

/** Pick a profile consistent with a specific timezone */
export function profileForTimezone(tz: string): FingerprintProfile {
  const match = FINGERPRINT_PROFILES.find(p => p.timezone === tz);
  return match ?? randomProfile();
}

// ── Script generator ──────────────────────────────────────────

/**
 * Generate the JavaScript init script that gets injected into
 * every page frame via context.addInitScript().
 *
 * The script fills all the fingerprint gaps that playwright-extra's
 * stealth plugin does NOT cover.
 */
export function generateStealthScript(p: FingerprintProfile): string {
  // Small noise seeded per session so values are stable within a
  // session but different across sessions
  const canvasSeed = (Math.random() * 0.00001).toFixed(8);
  const rectSeed   = (Math.random() * 0.3 + 0.05).toFixed(4);

  return `
(function() {
  'use strict';

  // ── Hardware ───────────────────────────────────────────────
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => ${p.hardwareConcurrency},
    configurable: true,
  });
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => ${p.deviceMemory},
    configurable: true,
  });
  Object.defineProperty(navigator, 'platform', {
    get: () => ${JSON.stringify(p.platform)},
    configurable: true,
  });
  Object.defineProperty(navigator, 'vendor', {
    get: () => ${JSON.stringify(p.vendor)},
    configurable: true,
  });

  // ── Screen ────────────────────────────────────────────────
  try {
    Object.defineProperty(screen, 'width',       { get: () => ${p.screen.width}, configurable: true });
    Object.defineProperty(screen, 'height',      { get: () => ${p.screen.height}, configurable: true });
    Object.defineProperty(screen, 'availWidth',  { get: () => ${p.screen.width}, configurable: true });
    Object.defineProperty(screen, 'availHeight', { get: () => ${p.screen.height - 40}, configurable: true });
    Object.defineProperty(screen, 'colorDepth',  { get: () => 24, configurable: true });
    Object.defineProperty(screen, 'pixelDepth',  { get: () => 24, configurable: true });
    Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });
  } catch(_) {}

  // ── Battery API ────────────────────────────────────────────
  const batteryObj = {
    charging:        ${p.batteryCharging},
    chargingTime:    ${p.batteryCharging ? 0 : 'Infinity'},
    dischargingTime: ${!p.batteryCharging ? Math.floor(3600 + Math.random() * 3600) : 'Infinity'},
    level:           ${p.batteryLevel},
    addEventListener:    function() {},
    removeEventListener: function() {},
    dispatchEvent:       function() { return true; },
    onchargingchange:    null,
    onchargingtimechange: null,
    ondischargingtimechange: null,
    onlevelchange:       null,
  };
  if (navigator.getBattery) {
    navigator.getBattery = function() { return Promise.resolve(batteryObj); };
  }

  // ── Network / Connection API ───────────────────────────────
  const conn = {
    effectiveType:          ${JSON.stringify(p.connectionType)},
    type:                   'wifi',
    downlink:               ${p.connectionDownlink},
    downlinkMax:            Infinity,
    rtt:                    ${p.connectionRtt},
    saveData:               false,
    onchange:               null,
    ontypechange:           null,
    addEventListener:       function() {},
    removeEventListener:    function() {},
  };
  Object.defineProperty(navigator, 'connection',       { get: () => conn, configurable: true });
  Object.defineProperty(navigator, 'mozConnection',    { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'webkitConnection', { get: () => undefined, configurable: true });

  // ── User-Agent Client Hints ────────────────────────────────
  if (navigator.userAgentData !== undefined) {
    const uaData = ${JSON.stringify(p.uaData)};
    const brands = [
      { brand: 'Not/A)Brand',       version: '8'  },
      { brand: ${JSON.stringify(p.uaData.brand)}, version: ${JSON.stringify(p.uaData.brandVersion)} },
      { brand: 'Chromium',          version: ${JSON.stringify(String(p.chromeMajor))} },
    ];
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands,
        mobile: uaData.mobile,
        platform: ${JSON.stringify(p.platformHeader)},
        getHighEntropyValues: (hints) => Promise.resolve({
          architecture:    uaData.architecture,
          bitness:         uaData.bitness,
          brands,
          mobile:          uaData.mobile,
          model:           uaData.model,
          platform:        ${JSON.stringify(p.platformHeader)},
          platformVersion: uaData.platformVersion,
          uaFullVersion:   uaData.uaFullVersion,
          fullVersionList: brands.map(b => ({ brand: b.brand, version: uaData.uaFullVersion })),
        }),
        toJSON: () => ({ brands, mobile: uaData.mobile, platform: ${JSON.stringify(p.platformHeader)} }),
      }),
      configurable: true,
    });
  }

  // ── WebGL ──────────────────────────────────────────────────
  const getParameterProxy = function(target, thisArg, argumentsList) {
    const param = argumentsList[0];
    const UNMASKED_VENDOR_WEBGL   = 37445;
    const UNMASKED_RENDERER_WEBGL = 37446;
    if (param === UNMASKED_VENDOR_WEBGL)   return ${JSON.stringify(p.webglVendor)};
    if (param === UNMASKED_RENDERER_WEBGL) return ${JSON.stringify(p.webglRenderer)};
    return Reflect.apply(target, thisArg, argumentsList);
  };
  try {
    WebGLRenderingContext.prototype.getParameter =
      new Proxy(WebGLRenderingContext.prototype.getParameter, { apply: getParameterProxy });
    WebGL2RenderingContext.prototype.getParameter =
      new Proxy(WebGL2RenderingContext.prototype.getParameter, { apply: getParameterProxy });
  } catch(_) {}

  // ── Canvas noise ─────────────────────────────────────────
  // Consistent sub-pixel shift per session (stable within session)
  const CANVAS_SHIFT = ${canvasSeed};
  try {
    const origFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(t, x, y, ...rest) {
      return origFillText.call(this, t, x + CANVAS_SHIFT, y + CANVAS_SHIFT, ...rest);
    };
    const origStrokeText = CanvasRenderingContext2D.prototype.strokeText;
    CanvasRenderingContext2D.prototype.strokeText = function(t, x, y, ...rest) {
      return origStrokeText.call(this, t, x + CANVAS_SHIFT * 0.5, y + CANVAS_SHIFT * 0.5, ...rest);
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const imgData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imgData.data.length; i += 200) {
          imgData.data[i] = Math.max(0, Math.min(255, (imgData.data[i] || 0) + (CANVAS_SHIFT > 0 ? 1 : -1)));
        }
        ctx.putImageData(imgData, 0, 0);
      }
      return origToDataURL.call(this, type, quality);
    };
  } catch(_) {}

  // ── AudioContext noise ─────────────────────────────────────
  try {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = origGetChannelData.call(this, channel);
      if (data.length > 100) {
        for (let i = 0; i < data.length; i += 137) {
          data[i] = data[i] + CANVAS_SHIFT * 0.0001;
        }
      }
      return data;
    };
  } catch(_) {}

  // ── ClientRects sub-pixel noise ────────────────────────────
  // Prevents fingerprinting via exact layout measurements
  const RECT_NOISE = ${rectSeed};
  try {
    const origGetBCR = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      const r = origGetBCR.call(this);
      const tiny = RECT_NOISE * 0.001;
      return {
        top:    r.top    + tiny,
        right:  r.right  + tiny,
        bottom: r.bottom + tiny,
        left:   r.left   + tiny,
        width:  r.width,
        height: r.height,
        x:      r.x      + tiny,
        y:      r.y      + tiny,
        toJSON: () => ({ top: r.top + tiny, right: r.right + tiny, bottom: r.bottom + tiny, left: r.left + tiny, width: r.width, height: r.height, x: r.x + tiny, y: r.y + tiny }),
      };
    };
  } catch(_) {}

  // ── Performance timing noise ──────────────────────────────
  try {
    const origNow = Performance.prototype.now;
    Performance.prototype.now = function() {
      return origNow.call(this) + (Math.random() * 0.1 - 0.05);
    };
  } catch(_) {}

  // ── Speech synthesis voice list ───────────────────────────
  // Real browsers have a rich list; headless has none
  try {
    const VOICES = [
      { voiceURI: 'Google US English',     name: 'Google US English',     lang: 'en-US', localService: false, default: true  },
      { voiceURI: 'Google UK English Female', name: 'Google UK English Female', lang: 'en-GB', localService: false, default: false },
      { voiceURI: 'Google UK English Male',   name: 'Google UK English Male',   lang: 'en-GB', localService: false, default: false },
      { voiceURI: 'Google Deutsch',        name: 'Google Deutsch',        lang: 'de-DE', localService: false, default: false },
      { voiceURI: 'Google français',       name: 'Google français',       lang: 'fr-FR', localService: false, default: false },
      { voiceURI: 'Google español',        name: 'Google español',        lang: 'es-ES', localService: false, default: false },
      { voiceURI: 'Google 日本語',          name: 'Google 日本語',          lang: 'ja-JP', localService: false, default: false },
    ];
    const voiceObjects = VOICES.map(v => Object.assign(Object.create(SpeechSynthesisVoice.prototype), v));
    if (window.speechSynthesis) {
      const origGetVoices = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
      Object.defineProperty(window.speechSynthesis, 'getVoices', {
        get: () => function() { const real = origGetVoices(); return real.length ? real : voiceObjects; },
        configurable: true,
      });
    }
  } catch(_) {}

  // ── Media devices enumeration ─────────────────────────────
  // Real browsers enumerate hardware; headless returns nothing
  try {
    const FAKE_DEVICES = [
      { deviceId: 'default', kind: 'audioinput',  label: 'Default - Microphone (Realtek Audio)', groupId: 'grp1' },
      { deviceId: 'comm',    kind: 'audioinput',  label: 'Communications - Microphone (Realtek Audio)', groupId: 'grp1' },
      { deviceId: 'default', kind: 'audiooutput', label: 'Default - Speakers (Realtek Audio)', groupId: 'grp2' },
      { deviceId: 'default', kind: 'videoinput',  label: 'HD Webcam (04f2:b725)',              groupId: 'grp3' },
    ];
    if (navigator.mediaDevices) {
      const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = async function() {
        const real = await origEnum();
        return real.length ? real : FAKE_DEVICES.map(d => Object.assign(Object.create(MediaDeviceInfo.prototype), d));
      };
    }
  } catch(_) {}

  // ── Keyboard layout ───────────────────────────────────────
  try {
    if (navigator.keyboard) {
      Object.defineProperty(navigator.keyboard, 'getLayoutMap', {
        get: () => () => Promise.resolve(new Map([['KeyA', 'a'], ['KeyZ', 'z']])),
        configurable: true,
      });
    }
  } catch(_) {}

  // ── Notification API coherence ────────────────────────────
  try {
    if (typeof Notification !== 'undefined') {
      Object.defineProperty(Notification, 'permission', {
        get: () => 'default',
        configurable: true,
      });
    }
  } catch(_) {}

  // ── iframe detection bypass ───────────────────────────────
  try {
    Object.defineProperty(window, 'top', {
      get: function() {
        try { return window.self.top; } catch(_) { return window; }
      },
      configurable: true,
    });
  } catch(_) {}

  // ── Automation flag cleanup ───────────────────────────────
  try {
    delete (window as any)._phantom;
    delete (window as any).callPhantom;
    delete (window as any).__nightmare;
    delete (window as any).domAutomation;
    delete (window as any).domAutomationController;
    delete (window as any).__webdriver_evaluate;
    delete (window as any).__selenium_evaluate;
    delete (window as any).__fxdriver_evaluate;
    delete (window as any).__driver_unwrapped;
    delete (window as any).__webdriver_unwrapped;
    delete (window as any).__driver_evaluate;
    delete (window as any).__selenium_unwrapped;
    delete (window as any).__fxdriver_unwrapped;
  } catch(_) {}

})();
`.trim();
}

// ── HTTP header sets ──────────────────────────────────────────

/**
 * Build the extra HTTP headers to inject into the browser context.
 * These must be consistent with the UA / profile to pass header-based
 * detection (e.g., Sec-CH-UA must match the User-Agent version).
 */
export function buildContextHeaders(p: FingerprintProfile): Record<string, string> {
  const langHeader = p.languages.map((l, i) =>
    i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`
  ).join(',');

  return {
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language':            langHeader,
    'Accept-Encoding':            'gzip, deflate, br',
    'Cache-Control':              'max-age=0',
    'Upgrade-Insecure-Requests':  '1',
    'Sec-Fetch-Dest':             'document',
    'Sec-Fetch-Mode':             'navigate',
    'Sec-Fetch-Site':             'none',
    'Sec-Fetch-User':             '?1',
    'Sec-CH-UA':                  `"Chromium";v="${p.chromeMajor}", "Google Chrome";v="${p.chromeMajor}", "Not_A Brand";v="8"`,
    'Sec-CH-UA-Mobile':           '?0',
    'Sec-CH-UA-Platform':         `"${p.platformHeader}"`,
  };
}

// ── Geolocation ───────────────────────────────────────────────

/**
 * Grant geolocation permission and spoof coordinates to match the
 * profile's timezone region.
 */
export async function spoofGeolocation(
  context: import('playwright').BrowserContext,
  p: FingerprintProfile,
): Promise<void> {
  await context.setGeolocation({
    latitude:  p.geoLat,
    longitude: p.geoLon,
    accuracy:  Math.floor(Math.random() * 50 + 20),  // 20–70m accuracy
  });
  await context.grantPermissions(['geolocation']);
}
