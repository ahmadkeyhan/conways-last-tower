import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs — fxhash serves the bundle from an arbitrary path / IPFS.
  base: './',
  plugins: [react()],
})
