import { sveltekit } from "@sveltejs/kit/vite";

function other(options: { readonly files: { readonly routes: string } }): object {
  return options;
}

export default { plugins: [sveltekit(), other({ files: { routes: "elsewhere" } })] };
