import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://estefania.mhsbsolutions.com',
  vite: {
    plugins: [tailwindcss()],
  },
});
