declare module "*.vue" {
  const component: { name: string };
  export default component;
  export const title: string;
  export const subtitle: string;
}

declare module "*.svg" {
  const url: string;
  export default url;
  export const raw: string;
  export const inline: string;
}

declare module "virtual:config" {
  export const mode: string;
}

declare module "*.png" {
  const url: string;
  export default url;
}
