// Global constants: endpoints and world-scale rendering knobs.

export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
export const WS_BASE = API_URL.replace(/^http/, "ws") + "/ws";
export const TILE_SIZE = 24;
export const OCEAN_PAD = 80;          // tiles of open sea drawn around the island (endless-ocean feel)
export const OCEAN_COLOR = 0x2c5f70;  // deep teal — canvas backdrop beyond the tiled water
export const VOID_COLOR = 0x140e12;   // mars / fallback backdrop
