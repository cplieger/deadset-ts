import { sveltekit } from "@sveltejs/kit/vite";

function copy(options: { readonly files: readonly string[] }): object {
  return options;
}

export default { plugins: [sveltekit(), copy({ files: ["static/robots.txt"] })] };
