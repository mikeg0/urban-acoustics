/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEVICE_ID?: string;
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_API_HOST?: string;
  readonly VITE_WS_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
