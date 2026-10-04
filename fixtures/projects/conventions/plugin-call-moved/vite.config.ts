import { sveltekit } from "@sveltejs/kit/vite";

export default { plugins: [sveltekit({ files: { routes: "app/pages" } })] };
