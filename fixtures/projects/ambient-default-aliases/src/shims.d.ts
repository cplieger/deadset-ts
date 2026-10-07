// Both default exports spell one reference, and only the second one is imported.
declare module "*.partly" {
  const unused: number;
  export default unused;
  export const named: number;
}

declare module "*.used" {
  const used: number;
  export default used;
}
